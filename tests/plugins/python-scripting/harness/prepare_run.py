"""Prepare isolated workspaces and host policies for one evaluation run."""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
from tempfile import TemporaryDirectory

from generate_fixture import FixtureManifest, generate_fixture, hash_tree
from oracle import write_report


_PREFIX = "python-scripting-eval-"
_MARKETPLACE_NAME = "python-scripting-test"
_PLUGIN_NAME = "python-scripting"
_RUNTIME_COMMANDS = (
    "python3",
    "env",
    "mktemp",
    "rm",
    "cat",
    "grep",
    "sed",
    "find",
    "sort",
    "head",
    "tail",
    "wc",
    "cut",
)


@dataclass(frozen=True)
class RunLayout:
    """Paths, policies, and immutable baseline evidence for one run."""

    repo_root: Path
    agent_workspace: Path
    staged_marketplace: Path
    staged_plugin: Path
    evaluator_workspace: Path
    codex_home: Path
    marketplace_manifest: Path
    fixture_manifest_path: Path
    baseline_hashes_path: Path
    baseline_hashes_sha256: str
    oracle_path: Path
    metadata_path: Path
    prompt_path: Path
    codex_config_path: Path
    claude_sandbox_profile: Path
    repository_sentinel: Path
    evaluator_sentinel: Path
    pre_run_hashes: dict[str, str]
    fixture_manifest: FixtureManifest
    plugin_sha256: str
    manifest_sha256: str
    oracle_sha256: str
    repository_revision: str
    minimal_path: str
    codex_executable: Path
    claude_executable: Path
    sandbox_executable: Path
    _temporary_directories: tuple[TemporaryDirectory[str], ...] = field(
        repr=False, compare=False
    )

    def read_prompt(self) -> str:
        """Return the exact prompt kept outside the agent workspace."""
        return self.prompt_path.read_text(encoding="utf-8")

    def cleanup(self) -> None:
        """Release only the three temporary roots owned by this layout."""
        for temporary in reversed(self._temporary_directories):
            temporary.cleanup()

    def __enter__(self) -> RunLayout:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.cleanup()


def prepare_run(repo_root: Path, output_root: Path | None) -> RunLayout:
    """Create isolated roots, fixture evidence, staged plugin, and policies."""
    repository = repo_root.expanduser().resolve(strict=True)
    destination = _resolve_output_root(output_root)
    if destination is not None and (
        destination == repository or destination.is_relative_to(repository)
    ):
        raise ValueError("evaluation roots must be outside the repository")
    if destination is not None:
        destination.mkdir(parents=True, exist_ok=True)

    temporaries: list[TemporaryDirectory[str]] = []
    try:
        for _ in range(3):
            temporaries.append(TemporaryDirectory(prefix=_PREFIX, dir=destination))
        agent_workspace, staged_marketplace, evaluator_workspace = (
            Path(temporary.name).resolve() for temporary in temporaries
        )

        staged_plugin = staged_marketplace / "plugins" / _PLUGIN_NAME
        staged_plugin.parent.mkdir(parents=True)
        plugin_source = repository / "plugins" / _PLUGIN_NAME
        _validate_copy_source(plugin_source)
        shutil.copytree(
            plugin_source,
            staged_plugin,
            symlinks=False,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
        )
        if any(path.is_symlink() for path in staged_plugin.rglob("*")):
            raise ValueError("staged plugin must contain copied files, not symlinks")

        marketplace_manifest = (
            staged_marketplace / ".agents" / "plugins" / "marketplace.json"
        )
        _write_json(
            marketplace_manifest,
            {
                "interface": {"displayName": "Python Scripting Test"},
                "name": _MARKETPLACE_NAME,
                "plugins": [
                    {
                        "category": "Development",
                        "name": _PLUGIN_NAME,
                        "policy": {
                            "authentication": "ON_INSTALL",
                            "installation": "AVAILABLE",
                        },
                        "source": {
                            "path": "./plugins/python-scripting",
                            "source": "local",
                        },
                    }
                ],
            },
        )

        fixture_manifest = generate_fixture(agent_workspace, evaluator_workspace)
        fixture_manifest_path = evaluator_workspace / "fixture-manifest.json"
        oracle_path = evaluator_workspace / "oracle.json"
        write_report(agent_workspace, oracle_path)
        pre_run_hashes = {
            relative: digest.sha256
            for relative, digest in hash_tree(agent_workspace).items()
        }
        baseline_hashes_path = evaluator_workspace / "baseline-hashes.json"
        _write_json(baseline_hashes_path, pre_run_hashes)
        baseline_hashes_sha256 = _sha256(baseline_hashes_path)

        prompt_path = evaluator_workspace / "prompt.txt"
        prompt_path.write_text(
            (repository / "tests/plugins/python-scripting/prompts/incidental-helper.txt")
            .read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        evaluator_sentinel = evaluator_workspace / "deny-sentinel"
        evaluator_sentinel.write_text("evaluator data must remain hidden\n", encoding="utf-8")
        repository_sentinel = repository / "package.json"
        if not repository_sentinel.is_file():
            raise ValueError("repository sentinel is unavailable")

        codex_home = evaluator_workspace / ".codex-home"
        codex_home.mkdir()
        minimal_path = _minimal_runtime_path()
        codex_config_path = codex_home / "config.toml"
        codex_config_path.write_text(
            _render_codex_config(
                repository,
                agent_workspace,
                staged_marketplace,
                evaluator_workspace,
                codex_home,
                minimal_path,
            ),
            encoding="utf-8",
        )

        codex_executable = _executable("codex")
        claude_executable = _executable("claude")
        sandbox_executable = _executable("sandbox-exec")
        claude_sandbox_profile = evaluator_workspace / "claude.sb"
        claude_sandbox_profile.write_text(
            _render_claude_profile(
                repository,
                agent_workspace,
                staged_plugin,
                evaluator_workspace,
                claude_executable,
            ),
            encoding="utf-8",
        )

        plugin_sha256 = _hash_tree_content(staged_plugin)
        manifest_sha256 = _sha256(fixture_manifest_path)
        oracle_sha256 = _sha256(oracle_path)
        revision = _repository_revision(repository)
        metadata_path = evaluator_workspace / "run-metadata.json"
        _write_json(
            metadata_path,
            {
                "cli_version": None,
                "command": [],
                "enabled_plugins": [_PLUGIN_NAME],
                "enabled_skills": _skill_names(staged_plugin),
                "fixture": {
                    "baseline_hashes_sha256": baseline_hashes_sha256,
                    "manifest_sha256": manifest_sha256,
                    "schema_version": fixture_manifest.schema_version,
                    "seed": fixture_manifest.seed,
                },
                "host": None,
                "instruction_sources": {
                    "repository": [],
                    "session_start": [],
                    "system": ["host built-ins"],
                    "user": ["exact prompt via stdin"],
                },
                "model": None,
                "plugin_sha256": plugin_sha256,
                "oracle_sha256": oracle_sha256,
                "repository_revision": revision,
            },
        )

        return RunLayout(
            repo_root=repository,
            agent_workspace=agent_workspace,
            staged_marketplace=staged_marketplace,
            staged_plugin=staged_plugin,
            evaluator_workspace=evaluator_workspace,
            codex_home=codex_home,
            marketplace_manifest=marketplace_manifest,
            fixture_manifest_path=fixture_manifest_path,
            baseline_hashes_path=baseline_hashes_path,
            baseline_hashes_sha256=baseline_hashes_sha256,
            oracle_path=oracle_path,
            metadata_path=metadata_path,
            prompt_path=prompt_path,
            codex_config_path=codex_config_path,
            claude_sandbox_profile=claude_sandbox_profile,
            repository_sentinel=repository_sentinel,
            evaluator_sentinel=evaluator_sentinel,
            pre_run_hashes=pre_run_hashes,
            fixture_manifest=fixture_manifest,
            plugin_sha256=plugin_sha256,
            manifest_sha256=manifest_sha256,
            oracle_sha256=oracle_sha256,
            repository_revision=revision,
            minimal_path=minimal_path,
            codex_executable=codex_executable,
            claude_executable=claude_executable,
            sandbox_executable=sandbox_executable,
            _temporary_directories=tuple(temporaries),
        )
    except BaseException:
        for temporary in reversed(temporaries):
            temporary.cleanup()
        raise


def _resolve_output_root(output_root: Path | None) -> Path | None:
    if output_root is None:
        return None
    destination = output_root.expanduser().resolve()
    return destination


def _validate_copy_source(root: Path) -> None:
    """Reject links and special files before the privileged parent copies them."""
    root_mode = root.lstat().st_mode
    if stat.S_ISLNK(root_mode):
        raise ValueError("plugin source root is a symlink")
    if not stat.S_ISDIR(root_mode):
        raise ValueError("plugin source root is not a directory")
    for directory_name, child_directories, child_files in os.walk(
        root, followlinks=False
    ):
        directory = Path(directory_name)
        for name in (*child_directories, *child_files):
            candidate = directory / name
            mode = candidate.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError(
                    f"plugin source contains symlink: {candidate.relative_to(root)}"
                )
            if name in child_directories and not stat.S_ISDIR(mode):
                raise ValueError(
                    f"plugin source contains non-directory: {candidate.relative_to(root)}"
                )
            if name in child_files and not stat.S_ISREG(mode):
                raise ValueError(
                    f"plugin source contains non-regular file: {candidate.relative_to(root)}"
                )


def _render_codex_config(
    repository: Path,
    agent_workspace: Path,
    staged_marketplace: Path,
    evaluator_workspace: Path,
    codex_home: Path,
    minimal_path: str,
) -> str:
    denied = "\n".join(
        f'{_toml_string(str(path))} = "deny"'
        for path in (repository, evaluator_workspace, staged_marketplace, codex_home)
    )
    return (
        'default_permissions = "python-scripting-test"\n\n'
        '[permissions.python-scripting-test.filesystem]\n'
        '\":minimal\" = \"read\"\n'
        f"{denied}\n\n"
        '[permissions.python-scripting-test.filesystem.\":workspace_roots\"]\n'
        '\".\" = \"write\"\n\n'
        '[permissions.python-scripting-test.network]\n'
        'enabled = false\n\n'
        '[shell_environment_policy]\n'
        'inherit = "none"\n'
        'ignore_default_excludes = false\n\n'
        '[shell_environment_policy.set]\n'
        f'PATH = {_toml_string(minimal_path)}\n'
        f'HOME = {_toml_string(str(agent_workspace))}\n'
        'LANG = "C.UTF-8"\n'
        'PYTHONNOUSERSITE = "1"\n\n'
        '[shell_environment_policy.filters]\n'
        '\"PATH\" = \"include\"\n'
        '\"HOME\" = \"include\"\n'
        '\"LANG\" = \"include\"\n'
        '\"PYTHONNOUSERSITE\" = \"include\"\n'
    )


def _render_claude_profile(
    repository: Path,
    agent_workspace: Path,
    staged_plugin: Path,
    evaluator_workspace: Path,
    claude_executable: Path,
) -> str:
    runtime_roots = (
        Path("/System"),
        Path("/Library/Apple"),
        Path("/usr/lib"),
        Path("/usr/bin"),
        Path("/bin"),
        Path("/opt/homebrew"),
        Path("/private/etc"),
        Path("/private/var/db"),
    )
    runtime_rules = "\n".join(
        f'    (subpath {_seatbelt_string(str(path))})' for path in runtime_roots
    )
    executable_paths = {claude_executable}
    if claude_executable.exists():
        executable_paths.add(claude_executable.resolve())
    executable_rules = "\n".join(
        f'    (literal {_seatbelt_string(str(path))})'
        for path in sorted(executable_paths)
    )
    return (
        '(version 1)\n'
        '(deny default)\n'
        '(allow process-fork)\n'
        '(allow process-info*)\n'
        '(allow signal)\n'
        '(allow sysctl-read)\n'
        '(allow mach-lookup)\n'
        '(allow network*)\n'
        '(allow file-read-metadata)\n'
        '(allow file-read*\n'
        f'    (subpath {_seatbelt_string(str(agent_workspace))})\n'
        f'    (subpath {_seatbelt_string(str(staged_plugin))})\n'
        f'{runtime_rules}\n'
        f'{executable_rules})\n'
        '(allow process-exec\n'
        f'{executable_rules}\n'
        '    (subpath "/usr/bin")\n'
        '    (subpath "/bin")\n'
        '    (subpath "/opt/homebrew"))\n'
        '(allow file-write*\n'
        f'    (subpath {_seatbelt_string(str(agent_workspace))})\n'
        '    (literal "/dev/null"))\n'
        '(deny file-read*\n'
        f'    (subpath {_seatbelt_string(str(repository))})\n'
        f'    (subpath {_seatbelt_string(str(evaluator_workspace))}))\n'
        '(deny file-write*\n'
        f'    (subpath {_seatbelt_string(str(repository))})\n'
        f'    (subpath {_seatbelt_string(str(evaluator_workspace))})\n'
        f'    (subpath {_seatbelt_string(str(staged_plugin))}))\n'
        '(deny process-exec (literal "/usr/bin/security"))\n'
    )


def _minimal_runtime_path() -> str:
    directories: list[str] = []
    for command in _RUNTIME_COMMANDS:
        found = shutil.which(command)
        if found is None:
            continue
        directory = str(Path(found).resolve().parent)
        if directory not in directories:
            directories.append(directory)
    for fallback in ("/usr/bin", "/bin"):
        if fallback not in directories:
            directories.append(fallback)
    return os.pathsep.join(directories)


def _executable(name: str) -> Path:
    found = shutil.which(name)
    return Path(found).absolute() if found is not None else Path(name)


def _repository_revision(repository: Path) -> str:
    completed = subprocess.run(
        ("git", "-C", str(repository), "rev-parse", "HEAD"),
        check=True,
        shell=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return completed.stdout.strip()


def _skill_names(staged_plugin: Path) -> list[str]:
    return [
        f"{_PLUGIN_NAME}:{path.parent.name}"
        for path in sorted((staged_plugin / "skills").glob("*/SKILL.md"))
    ]


def _hash_tree_content(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _seatbelt_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)
