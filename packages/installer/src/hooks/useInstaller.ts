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

            // Re-apply/confirm: an item is an install target if it's selected OR
            // already installed (and not queued for removal), mirroring how
            // reinstall.ts / install-package.ts prepare their descriptors.
            //
            // The pkgHasRemoval exemption is defensive only. It would matter if a
            // "files" package could have one item marked for removal and an
            // installed sibling unmarked, because installFiles copies the whole
            // manifest.files list rather than gating per item. Nothing produces
            // that state today: only App.ts toggleItem sets markedForRemoval, and
            // for "files" packages it marks every item at once.
            //
            // Known hole this does NOT close: toggleItem sets markedForRemoval
            // without clearing enabled, so a files package whose items differ in
            // install state (files present, settings key absent) keeps enabled on
            // the settings item and the install pass recopies what the removal
            // pass just unlinked. Pre-existing; the fix belongs in toggleItem.
            const prepared = packages.map((pkg) => {
                const pkgHasRemoval =
                    pkg.type === "files" && pkg.items.some((i) => i.markedForRemoval);
                return {
                    ...pkg,
                    items: pkg.items.map((item) =>
                        !item.markedForRemoval &&
                        (item.enabled || (item.alreadyInstalled && !pkgHasRemoval))
                            ? { ...item, enabled: true }
                            : item,
                    ),
                };
            });

            for (const pkg of prepared) {
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

            if (allResults.length === 0) {
                allResults.push({
                    packageId: "",
                    itemName: "",
                    status: "already-exists",
                    message: "Nothing to do — no items selected.",
                });
                setResults([...allResults]);
            }

            setPhase("done");
        },
        [],
    );

    return { phase, results, runInstall };
}
