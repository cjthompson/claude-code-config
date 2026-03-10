import { useState, useCallback } from "react";
import { installPackage, removePackage } from "../lib/install.ts";
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
                const hasInstalls = pkg.items.some((i) => i.enabled);
                const hasRemovals = pkg.items.some((i) => i.markedForRemoval);

                if (hasRemovals) {
                    const r = await removePackage(pkg);
                    allResults.push(...r);
                    setResults([...allResults]);
                }
                if (hasInstalls) {
                    const r = await installPackage(pkg);
                    allResults.push(...r);
                    setResults([...allResults]);
                }
            }

            setPhase("done");
        },
        [],
    );

    return { phase, results, runInstall };
}
