import { createElement as h } from "react";
import { Box, Text } from "ink";
import type { InstallResult } from "../lib/types.ts";

interface ResultsViewProps {
    results: InstallResult[];
}

export function ResultsView({ results }: ResultsViewProps) {
    return h(Box, { flexDirection: "column", marginTop: 1 },
        h(Text, { bold: true }, "Results"),
        h(Text, null, " "),
        ...results.map((r, i) => {
            const icon =
                r.status === "created" ? "\u2713" :
                r.status === "already-exists" ? "\u2013" : "\u2717";
            const color =
                r.status === "created" ? "green" :
                r.status === "already-exists" ? "yellow" : "red";

            return h(Text, { key: i },
                h(Text, { color }, ` ${icon}`),
                h(Text, null, ` ${r.message}`),
            );
        }),
        h(Text, null, " "),
        h(Text, { color: "gray" }, "Press q to exit"),
    );
}
