/**
 * normalize — pure string canonicalizers shared by the task-db CLI.
 *
 * Both functions are join keys: `normalizeProject` keys task rows to a repo,
 * `slugify` keys plan-document headings to task anchors. Changing either one
 * silently fragments existing data, so they live here alone, with no I/O and
 * no dependencies, and are covered by task-db.test.mts.
 */

/**
 * Normalize a project identifier to a canonical form so that different agents
 * (or different remote URL formats) all key into the same task list.
 *
 * Transformations:
 *   - strip trailing `.git`
 *   - convert SSH form (`git@host:owner/repo`) to HTTPS-style host path
 *   - drop scheme from HTTPS URLs
 *   - drop trailing slash
 *
 * Examples:
 *   git@github.com:cjthompson/claude-mixed-models.git
 *     -> github.com/cjthompson/claude-mixed-models
 *   https://github.com/cjthompson/claude-mixed-models.git
 *     -> github.com/cjthompson/claude-mixed-models
 *   git@github.com:cjthompson/claude-mixed-models
 *     -> github.com/cjthompson/claude-mixed-models
 *
 * @param {string|null|undefined} raw
 * @returns {string} canonical project key, or '' for empty input
 */
export function normalizeProject(raw) {
    let p = String(raw ?? '').trim();
    if (!p) return p;
    p = p.replace(/\.git$/, '');
    p = p.replace(/^git@([^:]+):/, '$1/');
    p = p.replace(/^https?:\/\//, '');
    p = p.replace(/\/$/, '');
    return p;
}

/**
 * Convert free-form text (typically a plan-document heading) into a URL-safe
 * anchor slug: lowercase, every run of non-alphanumeric characters collapsed
 * to a single `-`, leading/trailing `-` trimmed.
 *
 * Idempotent by construction — the output alphabet is `[a-z0-9-]` with no
 * leading, trailing, or repeated `-`, so a second pass is a no-op. This is a
 * hard requirement, not a nicety: the slug is the join key between plan
 * headings and task rows, so a non-idempotent slug silently duplicates tasks.
 *
 * Examples:
 *   "Step 1: Do the thing"  -> step-1-do-the-thing
 *   "  --Trailing junk!!  " -> trailing-junk
 *   "!!!"                   -> ''
 *
 * @param {string|null|undefined} text
 * @returns {string} slug containing only [a-z0-9-], possibly empty
 */
export function slugify(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}
