import { createElement as h } from "react";
import { Box, Text } from "ink";

interface DetailFooterProps {
    description: string;
}

export function DetailFooter({ description }: DetailFooterProps) {
    if (!description) return null;
    return h(Box, { marginTop: 1, borderStyle: "single", borderColor: "gray", paddingX: 1 },
        h(Text, { color: "gray", wrap: "wrap" }, description),
    );
}
