import { createElement as h } from "react";
import { Box, Text } from "ink";
import { ToggleItem } from "./ToggleItem.ts";

interface CardProps {
    label: string;
    description: string;
    enabled: boolean;
    items: Array<{ name: string; enabled: boolean; alreadyInstalled: boolean }>;
    focused: boolean;
    focusedItem: number;
}

export function Card({ label, description, enabled, items, focused, focusedItem }: CardProps) {
    const status = enabled ? "ON" : "OFF";
    const statusColor = enabled ? "green" : "gray";
    const borderColor = focused ? "cyan" : "gray";

    return h(Box, {
        flexDirection: "column",
        borderStyle: "round",
        borderColor,
        paddingX: 1,
    },
        h(Box, { justifyContent: "space-between" },
            h(Text, { bold: true }, label),
            h(Text, { color: statusColor, bold: true }, status),
        ),
        h(Text, { color: "gray" }, description),
        h(Text, null, " "),
        ...items.map((item, i) =>
            h(ToggleItem, {
                key: item.name,
                name: item.name,
                enabled: item.enabled,
                focused: focused && focusedItem === i,
                alreadyInstalled: item.alreadyInstalled,
            }),
        ),
    );
}
