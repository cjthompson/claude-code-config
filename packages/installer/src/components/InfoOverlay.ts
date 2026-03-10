import { createElement as h } from "react";
import { Box, Text } from "ink";

interface InfoOverlayProps {
    typeLabel: string;
    name: string;
    description: string;
}

export function InfoOverlay({ typeLabel, name, description }: InfoOverlayProps) {
    return h(Box, {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: "cyan",
        paddingX: 2,
        paddingY: 1,
    },
        h(Text, { bold: true, color: "cyan" }, `${typeLabel}: ${name}`),
        h(Text, null, " "),
        h(Text, { wrap: "wrap" }, description),
        h(Text, null, " "),
        h(Text, { color: "gray" }, "Press Esc to close"),
    );
}
