import { createElement as h } from "react";
import { Text } from "ink";

interface ToggleItemProps {
    name: string;
    enabled: boolean;
    focused: boolean;
    alreadyInstalled: boolean;
    markedForRemoval?: boolean;
}

export function ToggleItem({ name, enabled, focused, alreadyInstalled, markedForRemoval }: ToggleItemProps) {
    const cursor = focused ? "\u203a" : " ";

    let indicator: string;
    let indicatorColor: string;
    let suffix: string | null = null;

    if (markedForRemoval) {
        indicator = "\u2717"; // ✗
        indicatorColor = "red";
        suffix = " (remove)";
    } else if (alreadyInstalled) {
        indicator = "\u2713"; // ✓
        indicatorColor = "green";
        suffix = " (installed)";
    } else if (enabled) {
        indicator = "\u2713"; // ✓
        indicatorColor = "green";
    } else {
        indicator = "\u00b7"; // ·
        indicatorColor = "gray";
    }

    return h(Text, null,
        h(Text, { color: focused ? "cyan" : undefined }, cursor + " "),
        h(Text, { color: indicatorColor }, indicator),
        h(Text, null, " " + name),
        suffix ? h(Text, { color: markedForRemoval ? "red" : "gray" }, suffix) : null,
    );
}
