import { createElement as h, useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Card } from "./components/Card.ts";
import { InfoOverlay } from "./components/InfoOverlay.ts";
import { InstallButton } from "./components/InstallButton.ts";
import { ResultsView } from "./components/ResultsView.ts";
import { usePackageDiscovery } from "./hooks/usePackageDiscovery.ts";
import { useInstaller } from "./hooks/useInstaller.ts";

interface AppProps {
    repoRoot: string;
}

export function App({ repoRoot }: AppProps) {
    const { exit } = useApp();
    const { packages, setPackages, loading, error } = usePackageDiscovery(repoRoot);
    const { phase, results, runInstall } = useInstaller();

    const [focusIndex, setFocusIndex] = useState(0);
    const [cardItemIndex, setCardItemIndex] = useState<Record<number, number>>({});
    const [infoVisible, setInfoVisible] = useState(false);

    const hasSelections = packages.some((p) => p.enabled);
    const totalFocusable = packages.length + 1;

    const toggleItem = useCallback(
        (pkgIdx: number, itemIdx: number) => {
            setPackages((prev) => {
                return prev.map((p, pi) => {
                    if (pi !== pkgIdx) return p;
                    const pkg = { ...p };

                    if (pkg.type === "files") {
                        const newEnabled = !pkg.items[0]!.enabled;
                        pkg.items = pkg.items.map((item) => ({
                            ...item,
                            enabled: newEnabled,
                        }));
                        pkg.enabled = newEnabled;
                    } else {
                        pkg.items = pkg.items.map((item, ii) =>
                            ii === itemIdx ? { ...item, enabled: !item.enabled } : item,
                        );
                        pkg.enabled = pkg.items.some((i) => i.enabled);
                    }

                    return pkg;
                });
            });
        },
        [setPackages],
    );

    useInput(
        (input, key) => {
            if (phase === "done" || phase === "installing") {
                if (input === "q") exit();
                return;
            }

            if (infoVisible) {
                if (key.escape) setInfoVisible(false);
                return;
            }

            if (input === "q") {
                exit();
                return;
            }

            if (key.tab) {
                setFocusIndex((prev) =>
                    key.shift
                        ? (prev - 1 + totalFocusable) % totalFocusable
                        : (prev + 1) % totalFocusable,
                );
                return;
            }

            if (focusIndex < packages.length) {
                const pkg = packages[focusIndex]!;
                const currentItem = cardItemIndex[focusIndex] ?? 0;

                if (key.upArrow) {
                    setCardItemIndex((prev) => ({
                        ...prev,
                        [focusIndex]: Math.max(0, currentItem - 1),
                    }));
                } else if (key.downArrow) {
                    setCardItemIndex((prev) => ({
                        ...prev,
                        [focusIndex]: Math.min(pkg.items.length - 1, currentItem + 1),
                    }));
                } else if (input === " ") {
                    toggleItem(focusIndex, currentItem);
                } else if (input === "i") {
                    setInfoVisible(true);
                }
                return;
            }

            if (focusIndex === packages.length && key.return && hasSelections) {
                runInstall(packages);
            }
        },
    );

    if (loading) {
        return h(Text, null, "Discovering packages...");
    }

    if (error) {
        return h(Text, { color: "red" }, "Error: " + error);
    }

    if (packages.length === 0) {
        return h(Text, { color: "yellow" }, "No packages found.");
    }

    return h(Box, { flexDirection: "column", paddingX: 1 },
        h(Box, { justifyContent: "center", marginBottom: 1 },
            h(Text, { bold: true, color: "cyan" }, "Claude Code Config Installer"),
        ),

        phase === "selecting" && infoVisible ? (() => {
            const pkg = packages[focusIndex];
            const item = pkg?.items[cardItemIndex[focusIndex] ?? 0];
            return item
                ? h(InfoOverlay, {
                    key: "_info",
                    typeLabel: item.typeLabel ?? "Item",
                    name: item.name,
                    description: item.description ?? "(No description available)",
                })
                : null;
        })() : null,

        phase === "selecting" && !infoVisible ? [
            ...packages.map((pkg, i) =>
                h(Card, {
                    key: pkg.id,
                    label: pkg.label,
                    description: pkg.description,
                    enabled: pkg.enabled,
                    items: pkg.items,
                    focused: focusIndex === i,
                    focusedItem: cardItemIndex[i] ?? 0,
                }),
            ),
            h(InstallButton, {
                key: "_install",
                focused: focusIndex === packages.length,
                disabled: !hasSelections,
            }),
            h(Box, { key: "_help", justifyContent: "center", marginTop: 1 },
                h(Text, { color: "gray" },
                    "tab navigate  \u2191\u2193 items  space toggle  i info  enter install  q quit",
                ),
            ),
        ] : null,

        phase === "installing" ? h(Box, { flexDirection: "column" },
            h(Text, null, "Installing..."),
            h(ResultsView, { results }),
        ) : null,

        phase === "done" ? h(ResultsView, { results }) : null,
    );
}
