import { useState, useCallback } from "react";
import { installPackage } from "../lib/install.ts";
import type { PackageDescriptor, InstallResult } from "../lib/types.ts";

export type Phase = "selecting" | "installing" | "done";

export function useInstaller() {
    const [phase, setPhase] = useState<Phase>("selecting");
    const [results, setResults] = useState<InstallResult[]>([]);

    const runInstall = useCallback(
        async (packages: PackageDescriptor[]) => {
            setPhase("installing");
            const allResults: InstallResult[] = [];

            for (const pkg of packages) {
                if (!pkg.enabled) continue;
                const pkgResults = await installPackage(pkg);
                allResults.push(...pkgResults);
                setResults([...allResults]);
            }

            setPhase("done");
        },
        [],
    );

    return { phase, results, runInstall };
}
