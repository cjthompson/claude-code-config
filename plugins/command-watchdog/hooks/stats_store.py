"""The only module that opens stats.db. Opt-in: a missing file means collection is off."""
from __future__ import annotations

import glob
import json
import ntpath
import os
import sqlite3
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Mapping, Optional, Tuple

from output_tail import LINE_LIMIT, TAIL_LIMIT

SCHEMA_VERSION = 1
BUSY_TIMEOUT_MS = 200

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE rule_versions (
  rule_key TEXT NOT NULL, version INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (rule_key, version)
);

CREATE TABLE invocations (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
  command_line TEXT NOT NULL, primary_process TEXT NOT NULL, signature TEXT NOT NULL,
  loop_kind TEXT NOT NULL CHECK (loop_kind IN ('none','targeted','untargeted')),
  rule_key TEXT NOT NULL, rule_version INTEGER NOT NULL,
  env_overrides INTEGER NOT NULL, override_vars TEXT NOT NULL DEFAULT '',
  rtk_proxied INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failed','killed')),
  kill_reason TEXT CHECK (kill_reason IN ('idle','poll-idle','target-gone','max-runtime','orphaned')),
  fired_check TEXT NOT NULL CHECK (fired_check IN ('idle','max_runtime','poll_cap','none')),
  exit_code INTEGER,
  execution_time REAL NOT NULL, cpu_time REAL NOT NULL, max_silence REAL NOT NULL, no_output_time REAL NOT NULL,
  CHECK ((outcome = 'killed') = (kill_reason IS NOT NULL)),
  CHECK (
    (fired_check = 'idle' AND kill_reason IS NOT NULL AND kill_reason IN ('idle','poll-idle'))
    OR (fired_check = 'max_runtime' AND kill_reason IS NOT NULL AND kill_reason = 'max-runtime')
    OR (fired_check = 'poll_cap' AND kill_reason IS NOT NULL AND kill_reason = 'max-runtime' AND loop_kind = 'untargeted')
    OR (fired_check = 'none' AND (kill_reason IS NULL OR kill_reason IN ('target-gone','orphaned')))
  )
);

CREATE TABLE output_tail (
  invocation_id INTEGER NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL, ts TEXT NOT NULL, line TEXT NOT NULL,
  PRIMARY KEY (invocation_id, line_no)
);

CREATE TABLE counters (
  scope TEXT NOT NULL CHECK (scope IN ('global','primary_process','signature','rule','rule_override','kill_reason')),
  key TEXT NOT NULL,
  rule_version INTEGER NOT NULL DEFAULT 0,
  invocations INTEGER NOT NULL DEFAULT 0,
  successful INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  killed INTEGER NOT NULL DEFAULT 0,
  rtk_proxies INTEGER NOT NULL DEFAULT 0,
  killed_idle INTEGER NOT NULL DEFAULT 0,
  killed_max_runtime INTEGER NOT NULL DEFAULT 0,
  killed_poll_cap INTEGER NOT NULL DEFAULT 0,
  execution_sum REAL NOT NULL DEFAULT 0, cpu_sum REAL NOT NULL DEFAULT 0,
  max_silence_sum REAL NOT NULL DEFAULT 0, no_output_sum REAL NOT NULL DEFAULT 0,
  execution_max REAL NOT NULL DEFAULT 0, cpu_max REAL NOT NULL DEFAULT 0,
  max_silence_max REAL NOT NULL DEFAULT 0, no_output_max REAL NOT NULL DEFAULT 0,
  untargeted_successful INTEGER NOT NULL DEFAULT 0,
  untargeted_execution_max REAL NOT NULL DEFAULT 0,
  last_succeeded_at TEXT, last_killed_at TEXT,
  PRIMARY KEY (scope, key, rule_version)
);
"""


class StoreError(Exception):
    pass


def store_dir(env: Mapping[str, str] = os.environ, platform: str = sys.platform) -> str:
    override = env.get("COMMAND_WATCHDOG_HOME")
    if override:
        return override
    if platform == "darwin":
        return os.path.join(env["HOME"], "Library", "Application Support", "command-watchdog")
    if platform.startswith("win"):
        base = env.get("LOCALAPPDATA") or env.get("APPDATA")
        return ntpath.join(base, "command-watchdog")
    base = env.get("XDG_DATA_HOME") or os.path.join(env["HOME"], ".local", "share")
    return os.path.join(base, "command-watchdog")


def db_path(env: Mapping[str, str] = os.environ, platform: str = sys.platform) -> str:
    return os.path.join(store_dir(env, platform), "stats.db")


def is_enabled(path: Optional[str] = None) -> bool:
    return os.path.isfile(path or db_path())


def connect(path: str, readonly: bool = False) -> sqlite3.Connection:
    # Always mode=rw (never creates the file). A true mode=ro cannot open a WAL database
    # that has no -wal/-shm sidecars, so read-only is enforced with PRAGMA query_only.
    uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=rw"
    conn = sqlite3.connect(uri, uri=True,
                           timeout=BUSY_TIMEOUT_MS / 1000.0, isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout={}".format(BUSY_TIMEOUT_MS))
    conn.execute("PRAGMA synchronous=NORMAL")
    if readonly:
        conn.execute("PRAGMA query_only=ON")
    return conn


def check_schema(path: str) -> str:
    try:
        conn = connect(path, readonly=True)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return "corrupt"
    if row is None:
        return "corrupt"
    return "ok" if row[0] == str(SCHEMA_VERSION) else "unknown-version"


def enable(path: Optional[str] = None) -> str:
    target = path or db_path()
    if os.path.exists(target):
        status = check_schema(target)
        if status != "ok":
            raise StoreError("existing {} is {}; not overwritten".format(target, status))
        return target
    directory = os.path.dirname(target)
    os.makedirs(directory, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    os.close(handle)
    try:
        conn = sqlite3.connect(temp, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(SCHEMA)
            conn.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
            conn.execute("INSERT INTO meta(key, value) VALUES ('last_prune', '')")
            # Fold the WAL into the main file: only the main file is moved into place.
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()
        os.replace(temp, target)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise
    finally:
        for suffix in ("-wal", "-shm"):
            if os.path.exists(temp + suffix):
                os.unlink(temp + suffix)
    return target


@dataclass
class RunRecord:
    started_at: str
    ended_at: str
    command_line: str
    primary_process: str
    signature: str
    loop_kind: str
    rule_key: str
    ini_values: Dict[str, object]
    env_overrides: bool
    override_vars: Tuple[str, ...]
    rtk_proxied: bool
    outcome: str
    kill_reason: Optional[str]
    fired_check: str
    exit_code: Optional[int]
    execution_time: float
    cpu_time: float
    max_silence: float
    no_output_time: float
    output_tail: Tuple[Tuple[str, str], ...] = ()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _rule_version(conn, rule_key: str, ini_values: Dict[str, object], now: str) -> int:
    config_json = json.dumps(ini_values, sort_keys=True)
    latest = conn.execute(
        "SELECT version, config_json FROM rule_versions WHERE rule_key=? ORDER BY version DESC LIMIT 1",
        (rule_key,)).fetchone()
    if latest is not None and latest[1] == config_json:
        return latest[0]
    conn.execute(
        "INSERT OR IGNORE INTO rule_versions(rule_key, version, config_json, created_at) "
        "VALUES (?, COALESCE((SELECT MAX(version) FROM rule_versions WHERE rule_key=?), 0) + 1, ?, ?)",
        (rule_key, rule_key, config_json, now))
    row = conn.execute(
        "SELECT version FROM rule_versions WHERE rule_key=? AND config_json=? ORDER BY version DESC LIMIT 1",
        (rule_key, config_json)).fetchone()
    return row[0]


def _bump(conn, scope: str, key: str, version: int, rec: RunRecord) -> None:
    ok = rec.outcome == "success"
    killed = rec.outcome == "killed"
    # killed_idle / killed_max_runtime / killed_poll_cap are scope 'rule' only; other scopes leave them at 0.
    fired = rec.fired_check if killed and scope == "rule" else "none"
    success_values = {
        "execution": rec.execution_time if ok else 0.0,
        "cpu": rec.cpu_time if ok else 0.0,
        "max_silence": rec.max_silence if ok else 0.0,
        "no_output": rec.no_output_time if ok else 0.0,
    }
    untargeted = ok and rec.loop_kind == "untargeted"
    conn.execute(
        "INSERT INTO counters (scope, key, rule_version, invocations, successful, failed, killed, rtk_proxies, "
        "killed_idle, killed_max_runtime, killed_poll_cap, execution_sum, cpu_sum, max_silence_sum, no_output_sum, "
        "execution_max, cpu_max, max_silence_max, no_output_max, untargeted_successful, "
        "untargeted_execution_max, last_succeeded_at, last_killed_at) "
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(scope, key, rule_version) DO UPDATE SET "
        "invocations = invocations + 1, successful = successful + excluded.successful, "
        "failed = failed + excluded.failed, killed = killed + excluded.killed, "
        "rtk_proxies = rtk_proxies + excluded.rtk_proxies, "
        "killed_idle = killed_idle + excluded.killed_idle, "
        "killed_max_runtime = killed_max_runtime + excluded.killed_max_runtime, "
        "killed_poll_cap = killed_poll_cap + excluded.killed_poll_cap, "
        "execution_sum = execution_sum + excluded.execution_sum, cpu_sum = cpu_sum + excluded.cpu_sum, "
        "max_silence_sum = max_silence_sum + excluded.max_silence_sum, "
        "no_output_sum = no_output_sum + excluded.no_output_sum, "
        "execution_max = MAX(execution_max, excluded.execution_max), cpu_max = MAX(cpu_max, excluded.cpu_max), "
        "max_silence_max = MAX(max_silence_max, excluded.max_silence_max), "
        "no_output_max = MAX(no_output_max, excluded.no_output_max), "
        "untargeted_successful = untargeted_successful + excluded.untargeted_successful, "
        "untargeted_execution_max = MAX(untargeted_execution_max, excluded.untargeted_execution_max), "
        "last_succeeded_at = COALESCE(excluded.last_succeeded_at, last_succeeded_at), "
        "last_killed_at = COALESCE(excluded.last_killed_at, last_killed_at)",
        (scope, key, version,
         int(ok), int(rec.outcome == "failed"), int(killed), int(rec.rtk_proxied),
         int(fired == "idle"), int(fired == "max_runtime"), int(fired == "poll_cap"),
         success_values["execution"], success_values["cpu"], success_values["max_silence"], success_values["no_output"],
         success_values["execution"], success_values["cpu"], success_values["max_silence"], success_values["no_output"],
         int(untargeted), rec.execution_time if untargeted else 0.0,
         rec.ended_at if ok else None, rec.ended_at if killed else None))


def record_run(path: str, rec: RunRecord, now: Optional[str] = None) -> None:
    stamp = now or _now()
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            version = 0
            if not rec.env_overrides:
                version = _rule_version(conn, rec.rule_key, rec.ini_values, stamp)
            cursor = conn.execute(
                "INSERT INTO invocations (started_at, ended_at, command_line, primary_process, signature, loop_kind, "
                "rule_key, rule_version, env_overrides, override_vars, rtk_proxied, outcome, kill_reason, fired_check, "
                "exit_code, execution_time, cpu_time, max_silence, no_output_time) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (rec.started_at, rec.ended_at, rec.command_line, rec.primary_process, rec.signature, rec.loop_kind,
                 rec.rule_key, version, int(rec.env_overrides), ",".join(rec.override_vars), int(rec.rtk_proxied),
                 rec.outcome, rec.kill_reason, rec.fired_check, rec.exit_code, rec.execution_time, rec.cpu_time,
                 rec.max_silence, rec.no_output_time))
            if rec.outcome == "killed":
                for number, (ts, line) in enumerate(rec.output_tail[-TAIL_LIMIT:], start=1):
                    conn.execute("INSERT INTO output_tail(invocation_id, line_no, ts, line) VALUES (?,?,?,?)",
                                 (cursor.lastrowid, number, ts, line[:LINE_LIMIT]))
            _bump(conn, "global", "", 0, rec)
            _bump(conn, "primary_process", rec.primary_process, 0, rec)
            _bump(conn, "signature", rec.signature, 0, rec)
            if rec.env_overrides:
                _bump(conn, "rule_override", rec.rule_key, 0, rec)
            else:
                _bump(conn, "rule", rec.rule_key, version, rec)
            if rec.outcome == "killed":
                _bump(conn, "kill_reason", rec.kill_reason, 0, rec)
            if not rec.signature.startswith("rtk hook"):
                maybe_prune(conn, stamp)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


RETENTION_DAYS = 30
PRUNE_INTERVAL_HOURS = 24


def _meta_get(conn, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def _meta_set(conn, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def maybe_prune(conn, now: str) -> bool:
    current = datetime.fromisoformat(now)
    last = _meta_get(conn, "last_prune")
    if last:
        if current - datetime.fromisoformat(last) < timedelta(hours=PRUNE_INTERVAL_HOURS):
            return False
    cutoff = (current - timedelta(days=RETENTION_DAYS)).isoformat(timespec="seconds")
    conn.execute("DELETE FROM invocations WHERE ended_at < ?", (cutoff,))
    _meta_set(conn, "last_prune", now)
    return True


def claim_backup_path(stem: str, ext: str = "") -> str:
    """Create and return the first unused `stem`, `stem-2`, `stem-3`, ... path ending in `ext`.

    The file is created exclusively, so an existing backup is never overwritten. Shared by
    `reset` and command-watchdog-stats' ini backups."""
    suffix = 1
    while True:
        candidate = stem + ("" if suffix == 1 else "-" + str(suffix)) + ext
        try:
            os.close(os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
            return candidate
        except FileExistsError:
            suffix += 1


def reset(path: str, now: Optional[str] = None) -> str:
    stamp = datetime.fromisoformat(now or _now())
    stem = os.path.join(os.path.dirname(path), "stats-backup-" + stamp.strftime("%Y%m%d-%H%M%S"))
    backup = claim_backup_path(stem, ".db")
    try:
        source = connect(path, readonly=True)
        try:
            target = sqlite3.connect(backup)
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()
    except BaseException:
        try:
            os.unlink(backup)
        except FileNotFoundError:
            pass
        raise
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for table in ("output_tail", "invocations", "counters", "rule_versions"):
                conn.execute("DELETE FROM " + table)
            _meta_set(conn, "last_prune", "")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return backup


def delete_all(path: str) -> List[str]:
    candidates = [path, path + "-wal", path + "-shm"]
    # Escape the directory so a store path containing [, *, or ? never matches a sibling's backups.
    candidates += glob.glob(os.path.join(glob.escape(os.path.dirname(path)), "stats-backup-*.db"))
    removed: List[str] = []
    for candidate in candidates:
        if os.path.exists(candidate):
            os.unlink(candidate)
            removed.append(candidate)
    return removed
