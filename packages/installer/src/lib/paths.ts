import { join } from "node:path";

/**
 * Root of the user's Claude Code config.
 *
 * An accessor rather than a module-scope const so tests can retarget it at a
 * fixture directory; a const captured at import time would force HOME juggling
 * before every dynamic import.
 */
export function claudeDir(): string {
    return process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME!, ".claude");
}

export function skillsInstallDir(): string {
    return join(claudeDir(), "skills");
}

export function agentsInstallDir(): string {
    return join(claudeDir(), "agents");
}
