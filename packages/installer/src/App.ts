import { createElement as h, useState, useCallback, useMemo } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SectionHeader } from "./components/SectionHeader.ts";
import { DetailFooter } from "./components/DetailFooter.ts";
import { InfoOverlay } from "./components/InfoOverlay.ts";
import { ToggleItem } from "./components/ToggleItem.ts";
import { ResultsView } from "./components/ResultsView.ts";
import { usePackageDiscovery } from "./hooks/usePackageDiscovery.ts";
import { useInstaller } from "./hooks/useInstaller.ts";
import type { PackageDescriptor } from "./lib/types.ts";

interface AppProps {
    repoRoot: string;
}

interface FlatItem {
    pkgIdx: number;
    itemIdx: number;
}

function buildFlatItems(packages: PackageDescriptor[]): FlatItem[] {
    const flat: FlatItem[] = [];
    for (let pi = 0; pi < packages.length; pi++) {
        if (packages[pi]!.type === "plugin") continue;
        for (let ii = 0; ii < packages[pi]!.items.length; ii++) {
            flat.push({ pkgIdx: pi, itemIdx: ii });
        }
    }
    return flat;
}

export function App({ repoRoot }: AppProps) {
    const { exit } = useApp();
    const { packages, setPackages, loading, error } = usePackageDiscovery(repoRoot);
    const { phase, results, runInstall } = useInstaller();

    const [cursor, setCursor] = useState(0);
    const [infoVisible, setInfoVisible] = useState(false);

    const flat = useMemo(() => buildFlatItems(packages), [packages]);

    const hasSelections = packages.some((p) =>
        p.enabled || p.items.some((i) => i.markedForRemoval),
    );

    const focusedEntry = flat[cursor];
    const focusedPkg = focusedEntry ? packages[focusedEntry.pkgIdx] : undefined;
    const focusedItem = focusedEntry && focusedPkg
        ? focusedPkg.items[focusedEntry.itemIdx]
        : undefined;
    const footerDescription = focusedItem?.description ?? focusedPkg?.description ?? "";

    const toggleItem = useCallback(
        (pkgIdx: number, itemIdx: number) => {
            setPackages((prev) => {
                return prev.map((p, pi) => {
                    if (pi !== pkgIdx) return p;
                    const pkg = { ...p };

                    if (pkg.type === "files") {
                        const item = pkg.items[0]!;
                        if (item.alreadyInstalled) {
                            const marking = !item.markedForRemoval;
                            pkg.items = pkg.items.map((i) => ({ ...i, markedForRemoval: marking }));
                        } else {
                            const newEnabled = !item.enabled;
                            pkg.items = pkg.items.map((i) => ({ ...i, enabled: newEnabled }));
                            pkg.enabled = newEnabled;
                        }
                    } else {
                        pkg.items = pkg.items.map((item, ii) => {
                            if (ii !== itemIdx) return item;
                            if (item.alreadyInstalled) {
                                return { ...item, markedForRemoval: !item.markedForRemoval };
                            }
                            return { ...item, enabled: !item.enabled };
                        });
                        pkg.enabled = pkg.items.some((i) => i.enabled);
                    }

                    return pkg;
                });
            });
        },
        [setPackages],
    );

    useInput((input, key) => {
        if (phase === "done" || phase === "installing") {
            if (input === "q") exit();
            return;
        }

        if (infoVisible) {
            if (key.escape || input === "i") setInfoVisible(false);
            return;
        }

        if (input === "q") { exit(); return; }

        if (key.upArrow) {
            setCursor((c) => Math.max(0, c - 1));
        } else if (key.downArrow) {
            setCursor((c) => Math.min(flat.length - 1, c + 1));
        } else if (input === " " && focusedEntry) {
            toggleItem(focusedEntry.pkgIdx, focusedEntry.itemIdx);
        } else if (input === "i" && focusedItem) {
            setInfoVisible(true);
        } else if (key.return && hasSelections) {
            runInstall(packages);
        }
    });

    if (loading) return h(Text, null, "Discovering packages...");
    if (error) return h(Text, { color: "red" }, "Error: " + error);
    if (flat.length === 0) return h(Text, { color: "yellow" }, "No packages found.");

    if (phase === "installing") {
        return h(Box, { flexDirection: "column", paddingX: 1 },
            h(Text, null, "Installing..."),
            h(ResultsView, { results }),
        );
    }

    if (phase === "done") {
        return h(Box, { paddingX: 1 }, h(ResultsView, { results }));
    }

    if (infoVisible && focusedItem) {
        return h(Box, { flexDirection: "column", paddingX: 1 },
            h(InfoOverlay, {
                typeLabel: focusedItem.typeLabel ?? "Item",
                name: focusedItem.name,
                description: focusedItem.description ?? "(No description available)",
            }),
        );
    }

    // Build list nodes: section header per package group, then indented items
    const listNodes: ReturnType<typeof h>[] = [];
    let lastPkgIdx = -1;

    for (let ci = 0; ci < flat.length; ci++) {
        const { pkgIdx, itemIdx } = flat[ci]!;
        const pkg = packages[pkgIdx]!;
        const item = pkg.items[itemIdx]!;

        if (pkgIdx !== lastPkgIdx) {
            lastPkgIdx = pkgIdx;
            const hasRemovals = pkg.items.some((i) => i.markedForRemoval);
            const hasUpgrades = pkg.items.some((i) => i.needsUpgrade);
            const status = hasRemovals ? "REMOVE" : hasUpgrades ? "UPGRADE" : pkg.enabled ? "ON" : "OFF";
            listNodes.push(h(SectionHeader, { key: `hdr-${pkgIdx}`, label: pkg.label, status }));
        }

        listNodes.push(h(Box, { key: `item-${pkgIdx}-${itemIdx}`, paddingLeft: 2 },
            h(ToggleItem, {
                name: item.name,
                enabled: item.enabled,
                focused: ci === cursor,
                alreadyInstalled: item.alreadyInstalled,
                needsUpgrade: item.needsUpgrade,
                isCurrent: item.isCurrent,
                markedForRemoval: item.markedForRemoval,
            }),
        ));
    }

    const installLine = hasSelections
        ? h(Text, { color: "cyan" }, "↵ Install Selected")
        : h(Text, { color: "gray", dimColor: true }, "↵ Nothing selected");

    return h(Box, { flexDirection: "column", paddingX: 1 },
        h(Box, { justifyContent: "center", marginBottom: 1 },
            h(Text, { bold: true, color: "cyan" }, "Claude Code Config Installer"),
        ),
        ...listNodes,
        h(Box, { marginTop: 1 }, installLine),
        h(DetailFooter, { description: footerDescription }),
        h(Box, { justifyContent: "center", marginTop: 1 },
            h(Text, { color: "gray" },
                "↑↓ move  space toggle  i info  enter install  q quit",
            ),
        ),
    );
}
