export interface PackageItem {
    name: string;
    enabled: boolean;
    alreadyInstalled: boolean;
    /** Absolute path to source (for skills: the skill dir, for files: the source file) */
    sourcePath?: string;
    /** Description shown in the info overlay (from SKILL.md or manifest) */
    description?: string;
    /** Type label shown in info overlay header, e.g. "Skill" or "Package" */
    typeLabel?: string;
    /** Whether this installed item is queued for removal */
    markedForRemoval?: boolean;
}

/**
 * Declarative detection rules for a package or item.
 * All specified checks must pass for the item to be considered installed.
 */
export interface DetectSpec {
    /** Paths that must exist (supports ~ expansion). Checks existence only, not symlink target. */
    files?: string[];
    /** Keys that must be present in ~/.claude/settings.json */
    settings?: string[];
}

export interface PackageManifest {
    label: string;
    description: string;
    type: "skills" | "files";
    /** For "files" type: list of files to copy to ~/.claude/ */
    files?: string[];
    /** For "files" type: key-value pairs to merge into ~/.claude/settings.json */
    settings?: Record<string, unknown>;
    /** Optional example output shown in the info overlay */
    example?: string;
    /**
     * Optional detection overrides per item name.
     * Key is the item name (skill name or file name). If omitted, type-based defaults apply.
     */
    detect?: Record<string, DetectSpec>;
}

export interface PackageDescriptor {
    id: string;
    label: string;
    description: string;
    type: "skills" | "files";
    enabled: boolean;
    items: PackageItem[];
    /** Absolute path to the package directory */
    packageDir: string;
    /** Original manifest data */
    manifest: PackageManifest;
}

export interface InstallResult {
    packageId: string;
    itemName: string;
    status: "created" | "already-exists" | "removed" | "error";
    message: string;
}
