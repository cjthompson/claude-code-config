"""Rule file: INI loading, per-key merge, value parsing, and limit resolution."""
from __future__ import annotations

import configparser
import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

BUILTIN_GLOBAL: Dict[str, object] = {
    "idle": 90, "max_runtime": None, "poll": 5, "poll_cap": 1800,
    "nice": True, "acceptable_kill_percent": 25,
}
BUILTIN_COMMANDS: Dict[str, Dict[str, object]] = {"rtk": {"max_runtime": 15}}
KEYS = ("idle", "max_runtime", "poll", "poll_cap", "nice", "acceptable_kill_percent")
# Per-run override variables, in the order resolve() applies them. The single source for
# every consumer (resolve, command-watchdog's environment read, command_identity's lift table).
ENV_NAMES = {"idle": "WATCHDOG_IDLE", "max_runtime": "WATCHDOG_MAX_RUNTIME",
             "poll_cap": "WATCHDOG_POLL_CAP", "poll": "WATCHDOG_POLL"}
# Overrides a command may lift from its own leading assignments; WATCHDOG_POLL is env-only.
LIFTABLE_KEYS = ("idle", "max_runtime", "poll_cap")


def new_parser() -> configparser.ConfigParser:
    """The one parser setup for rule files, shared by the hook and command-watchdog-stats.

    No real section can be named like this, so [DEFAULT] round-trips as an ordinary section: its keys
    are never copied into other sections, and the file's [DEFAULT] is written back unchanged."""
    return configparser.ConfigParser(interpolation=None, strict=False, default_section="\x00none")


@dataclass(frozen=True)
class Limits:
    idle: Optional[int]
    max_runtime: Optional[int]
    poll: int
    poll_cap: Optional[int]
    nice: bool
    acceptable_kill_percent: int


@dataclass(frozen=True)
class Resolution:
    limits: Limits
    rule_key: str
    ini_values: Dict[str, object]
    overridden: bool
    override_vars: Tuple[str, ...]
    warnings: Tuple[str, ...]


@dataclass
class Rules:
    global_values: Dict[str, object] = field(default_factory=dict)
    commands: Dict[str, Dict[str, object]] = field(default_factory=dict)
    rules: List[Tuple[str, "re.Pattern[str]", Dict[str, object]]] = field(default_factory=list)


def parse_value(key: str, raw: str):
    value = raw.strip().lower()
    if key == "nice":
        if value in ("on", "off"):
            return value == "on"
        raise ValueError("nice must be on or off")
    if key == "acceptable_kill_percent":
        number = int(value)
        if not 1 <= number <= 100:
            raise ValueError("acceptable_kill_percent must be 1..100")
        return number
    if key == "poll":
        number = int(value)
        if number <= 0:
            raise ValueError("poll must be a positive integer")
        return number
    if value in ("-1", "off"):
        return None
    number = int(value)
    if key == "max_runtime" and number == 0:
        return None
    if number <= 0:
        raise ValueError("{} must be positive, or -1/off".format(key))
    return number


def _merge_section(target: Dict[str, object], section: configparser.SectionProxy,
                   warnings: List[str], label: str) -> None:
    for key, raw in section.items():
        if key == "regex":
            continue
        if key not in KEYS:
            warnings.append("{}: unknown key {}".format(label, key))
            continue
        try:
            target[key] = parse_value(key, raw)
        except ValueError as error:
            warnings.append("{}: {}".format(label, error))


def load_rules(paths: Sequence[str]) -> Tuple[Rules, List[str]]:
    rules = Rules()
    warnings: List[str] = []
    rule_index: Dict[str, int] = {}
    for path in paths:
        if not os.path.isfile(path):
            continue
        # No inherited default section: [DEFAULT] is read as an ordinary section, so its keys
        # reach only the file's [global] (see below), never a rule or command section.
        parser = new_parser()
        try:
            parser.read(path, encoding="utf-8")
        except (configparser.MissingSectionHeaderError, UnicodeDecodeError, OSError) as error:
            warnings.append("{}: {}".format(path, error))
            continue
        except configparser.ParsingError as error:
            # configparser finishes parsing and then raises; valid sections and keys remain.
            warnings.append("{}: {}".format(path, error))
        except configparser.Error as error:
            warnings.append("{}: {}".format(path, error))
            continue
        # [DEFAULT] is a base under this file's [global]: its keys apply only where [global] is
        # silent, and rule and command sections never inherit them.
        file_global: Dict[str, object] = {}
        if parser.has_section("DEFAULT"):
            _merge_section(file_global, parser["DEFAULT"], warnings, "[DEFAULT]")
        if parser.has_section("global"):
            _merge_section(file_global, parser["global"], warnings, "[global]")
        rules.global_values.update(file_global)
        for name in parser.sections():
            section = parser[name]
            if name in ("global", "DEFAULT"):
                continue  # merged above
            elif name.startswith("command:"):
                prefix = name[len("command:"):].strip()
                values = rules.commands.setdefault(prefix, {})
                _merge_section(values, section, warnings, name)
            elif name.startswith("rule:"):
                rule_name = name[len("rule:"):].strip()
                regex_text = section.get("regex", "")
                if not regex_text.strip():
                    if rule_name in rule_index:
                        # A later file may override only some keys of a rule defined earlier; it
                        # keeps that rule's regex.
                        _merge_section(rules.rules[rule_index[rule_name]][2], section, warnings, name)
                    else:
                        # An empty pattern would match every command (a `regexp:` typo, say).
                        warnings.append("{}: missing or empty regex; section skipped".format(name))
                    continue
                try:
                    pattern = re.compile(regex_text)
                except re.error as error:
                    warnings.append("{}: invalid regex ({}); section skipped".format(name, error))
                    continue
                if rule_name in rule_index:
                    index = rule_index[rule_name]
                    old_name, _, values = rules.rules[index]
                    rules.rules[index] = (old_name, pattern, values)
                else:
                    values = {}
                    rule_index[rule_name] = len(rules.rules)
                    rules.rules.append((rule_name, pattern, values))
                _merge_section(values, section, warnings, name)
            else:
                warnings.append("{}: unknown section".format(name))
    return rules, warnings


def _longest_command(table: Dict[str, Dict[str, object]], signature: str) -> Optional[str]:
    best = None
    for prefix in table:
        if signature == prefix or signature.startswith(prefix + " "):
            if best is None or len(prefix) > len(best):
                best = prefix
    return best


def resolve(rules: Rules, signature: str, cmd: str, overrides: Dict[str, str],
            match_rules: bool = True) -> Resolution:
    """Merge the layers for `cmd`. `match_rules=False` skips the [rule:] layer; the hook's own rtk
    rewrite lookup uses it so no user rule can remove its built-in cap."""
    warnings: List[str] = []
    layers: List[Tuple[str, Dict[str, object]]] = []
    rule_key = "global"

    for name, pattern, values in (rules.rules if match_rules else []):
        if pattern.search(cmd):
            layers.append(("rule:" + name, values))
            rule_key = "rule:" + name
            break

    command = _longest_command(rules.commands, signature)
    if command is not None:
        layers.append(("command:" + command, rules.commands[command]))
        if rule_key == "global":
            rule_key = "command:" + command

    builtin = _longest_command(BUILTIN_COMMANDS, signature)
    if builtin is not None:
        layers.append(("builtin:" + builtin, BUILTIN_COMMANDS[builtin]))
        if rule_key == "global":
            rule_key = "command:" + builtin

    layers.append(("global", rules.global_values))

    ini: Dict[str, object] = {}
    for _label, layer in layers:
        for key, value in layer.items():
            ini.setdefault(key, value)
    for key, value in BUILTIN_GLOBAL.items():
        ini.setdefault(key, value)

    effective = dict(ini)
    applied: List[str] = []
    for key in ENV_NAMES:
        if key not in overrides:
            continue
        try:
            effective[key] = parse_value(key, overrides[key])
            applied.append(ENV_NAMES[key])
        except ValueError as error:
            warnings.append("{}: {}".format(ENV_NAMES[key], error))

    limits = Limits(
        idle=effective["idle"], max_runtime=effective["max_runtime"], poll=effective["poll"],
        poll_cap=effective["poll_cap"], nice=effective["nice"],
        acceptable_kill_percent=effective["acceptable_kill_percent"],
    )
    return Resolution(limits=limits, rule_key=rule_key, ini_values=ini, overridden=bool(applied),
                      override_vars=tuple(applied), warnings=tuple(warnings))
