import { createElement as h } from "react";
import { Text } from "ink";

interface ToggleItemProps {
    name: string;
    enabled: boolean;
    focused: boolean;
    alreadyInstalled: boolean;
}

export function ToggleItem({ name, enabled, focused, alreadyInstalled }: ToggleItemProps) {
    const indicator = enabled ? "\u2713" : "\u00b7";
    const indicatorColor = enabled ? "green" : "gray";
    const cursor = focused ? "\u203a" : " ";

    return h(Text, null,
        h(Text, { color: focused ? "cyan" : undefined }, cursor + " "),
        h(Text, { color: indicatorColor }, indicator),
        h(Text, null, " " + name),
        alreadyInstalled ? h(Text, { color: "gray" }, " (installed)") : null,
    );
}
