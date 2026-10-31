"""Command identity: lift per-run WATCHDOG_* overrides, primary process, and signature."""
import os
import re
import shlex
from typing import Dict, FrozenSet, List, Tuple

from watchdog_config import ENV_NAMES, LIFTABLE_KEYS

# Variable name -> rule key, for the overrides a command may lift (see watchdog_config.LIFTABLE_KEYS).
LIFTABLE = {ENV_NAMES[key]: key for key in LIFTABLE_KEYS}
VALUE_RE = re.compile(r"\A(-1|off|\d+)\Z")
TOKEN_ASSIGN_RE = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*=")
CD_RE = re.compile(r"\A\s*cd\s+(?:'[^']*'|\"[^\"]*\"|\S+)\s*(?:&&|;)\s*")

SIGNATURE_PAIRS: FrozenSet[str] = frozenset({"npm run", "pnpm run", "bun run", "yarn run", "docker compose"})
VALUE_FLAGS: Dict[str, FrozenSet[str]] = {
    "git": frozenset({"-C", "-c", "--git-dir", "--work-tree"}),
    "docker": frozenset({"-H", "--context", "-c"}),
    "docker compose": frozenset({"-f", "--file", "-p", "--project-name", "--env-file"}),
    "npm": frozenset({"--prefix", "-w", "--workspace"}),
    "pnpm": frozenset({"--prefix", "-w", "--workspace"}),
    "yarn": frozenset({"--prefix", "-w", "--workspace"}),
}
WRAPPER_PAIRS = frozenset({("bundle", "exec"), ("pnpm", "exec"), ("uv", "run"), ("poetry", "run")})
MAX_DEPTH = 5
# `timeout` options that take a separate value; `-s9` and `--signal=KILL` carry it inline.
TIMEOUT_VALUE_FLAGS = frozenset({"-s", "--signal", "-k", "--kill-after"})


BLANKS = " \t"
# An assignment value containing any of these needs the quote-aware check in _word_end:
# quoted text is skipped whole, while an expansion, escape, or operator stops scanning.
UNSAFE_VALUE_CHARS = frozenset("'\"\\$`();&|<>")
ASSIGN_AT_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=(\S*)")
# An override-variable assignment anywhere in a command, used only to report one that scanning missed.
STRANDED_RE = re.compile(r"(?<!\S)(?:%s)=\S*" % "|".join(LIFTABLE))


def _word_end(cmd: str, start: int) -> Tuple[int, bool]:
    """End of the shell word at `start`, and whether that word is plain.

    Blanks inside quotes do not end the word. A word is plain when it holds only quoted
    text: no expansion, backslash, operator, or unterminated quote."""
    quote = ""
    index = start
    while index < len(cmd):
        char = cmd[index]
        if quote == "'":
            if char == "'":
                quote = ""
        elif quote == '"':
            if char == '"':
                quote = ""
            elif char in "$`\\":
                return index, False
        elif char in BLANKS or char in "\r\n":
            break
        elif char in "'\"":
            quote = char
        elif char in "$`\\();&|<>":
            return index, False
        index += 1
    return index, quote == ""


def lift_overrides(cmd: str) -> Tuple[Dict[str, str], List[str], str]:
    """Lift WATCHDOG_IDLE/MAX_RUNTIME/POLL_CAP assignments from the start of `cmd`.

    An optional leading `cd dir &&` or `cd dir;` is skipped and stays in the command, so
    overrides after it still lift. Returns (overrides, rejected, remaining)."""
    cd = CD_RE.match(cmd)
    if not cd:
        return _lift_leading(cmd)
    overrides, rejected, rest = lift_overrides(cmd[cd.end():])
    if not rest:
        # Nothing would run after the cd; cutting the assignments would leave it dangling.
        return {}, rejected, cmd
    return overrides, rejected, cmd[:cd.end()] + rest


def _lift_leading(cmd: str) -> Tuple[Dict[str, str], List[str], str]:
    """Lift WATCHDOG_IDLE/MAX_RUNTIME/POLL_CAP assignments out of `cmd`.

    Returns (overrides, rejected, remaining). `remaining` is `cmd` with only the
    lifted assignment tokens (and the blanks after them) cut out: every other
    byte is kept, including newlines and runs of spaces. A token is lifted only
    when plain blanks (or the end of the text) follow it and the text after it
    does not start with a shell operator or newline, so the remaining text is
    never rewritten into something the user did not write. Rejected tokens
    (invalid values) are reported but stay in the command. `remaining` is empty
    when nothing but lifted assignments (and blanks) was there."""
    overrides: Dict[str, str] = {}
    rejected: List[str] = []
    spans: List[Tuple[int, int]] = []
    pos = 0
    while True:
        start = pos
        while start < len(cmd) and cmd[start] in BLANKS:
            start += 1
        match = ASSIGN_AT_RE.match(cmd, start)
        if not match:
            break
        name, value = match.group(1), match.group(2)
        end = match.end()
        if end < len(cmd) and cmd[end] not in BLANKS:
            break  # newline or other whitespace right after the token
        blank_end = end
        while blank_end < len(cmd) and cmd[blank_end] in BLANKS:
            blank_end += 1
        if any(char in UNSAFE_VALUE_CHARS for char in value):
            word_end, plain = _word_end(cmd, start)
            if plain and name not in LIFTABLE:
                pos = word_end  # a quoted word that is not an override: skip it whole
                continue
            if name in LIFTABLE:
                rejected.append(match.group(0))  # logged; the text stays in the command
            else:
                # Scanning stops here; report any override it strands so the log explains the miss.
                rejected.extend(found.group(0) for found in STRANDED_RE.finditer(cmd, word_end))
            break  # an expansion, escape, or operator: stop rather than guess
        if name in LIFTABLE:
            if VALUE_RE.match(value):
                if blank_end < len(cmd) and cmd[blank_end] in ";&|\n\r":
                    break  # cutting it out would leave a dangling operator
                overrides[LIFTABLE[name]] = value
                spans.append((start, blank_end))
            else:
                rejected.append(match.group(0))
        pos = blank_end
    remaining = cmd
    for start, end in reversed(spans):
        remaining = remaining[:start] + remaining[end:]
    if not remaining.strip():
        remaining = ""
    return overrides, rejected, remaining


def _first_segment(cmd: str) -> str:
    quote = None
    for index, char in enumerate(cmd):
        if quote:
            if char == quote:
                quote = None
        elif char in "'\"":
            quote = char
        elif char in ";|&":
            return cmd[:index]
    return cmd


def _tokens(segment: str) -> List[str]:
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def _unwrap(cmd: str, depth: int = 0) -> List[str]:
    if depth > MAX_DEPTH:
        return []
    cmd = CD_RE.sub("", cmd, count=1)
    tokens = _tokens(_first_segment(cmd))
    while tokens:
        t0 = os.path.basename(tokens[0])
        if TOKEN_ASSIGN_RE.match(tokens[0]):
            tokens = tokens[1:]
        elif t0 == "env":
            tokens = tokens[1:]
        elif t0 == "timeout":
            tokens = tokens[1:]
            while tokens and tokens[0].startswith("-"):
                tokens = tokens[2:] if tokens[0] in TIMEOUT_VALUE_FLAGS else tokens[1:]
            tokens = tokens[1:]  # the DURATION operand
        elif len(tokens) > 1 and (t0, tokens[1]) in WRAPPER_PAIRS:
            tokens = tokens[2:]
        elif t0 == "npx":
            tokens = tokens[1:]
        elif t0 == "rtk" and len(tokens) > 1 and tokens[1] != "hook":
            tokens = tokens[1:]
        elif t0 in ("bash", "sh") and tokens[1:2] == ["-c"] and len(tokens) >= 3:
            return _unwrap(tokens[2], depth + 1)
        else:
            return tokens
    return tokens


def primary_process(cmd: str) -> str:
    tokens = _unwrap(cmd)
    return os.path.basename(tokens[0]) if tokens else ""


def _flags_for(words: List[str]) -> FrozenSet[str]:
    return VALUE_FLAGS.get(" ".join(words), frozenset())


def signature(cmd: str) -> str:
    tokens = _unwrap(cmd)
    if not tokens:
        return ""
    first = os.path.basename(tokens[0])
    rest = tokens[1:]
    index = 0

    def next_positional(words: List[str]):
        nonlocal index
        flags = _flags_for(words)
        while index < len(rest):
            token = rest[index]
            index += 1
            if token == "--":
                return None
            if token.startswith("--") and "=" in token:
                continue
            if token.startswith("-"):
                if token in flags:
                    index += 1
                continue
            return token
        return None

    second = next_positional([first])
    if second is None:
        return first
    words = [first, second]
    if " ".join(words) in SIGNATURE_PAIRS:
        third = next_positional(words)
        if third is not None:
            words.append(third)
    return " ".join(words)
