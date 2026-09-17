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
                r.status === "updated" ? "\u2191" :
                r.status === "removed" ? "\u2717" :
                r.status === "already-exists" ? "\u2013" :
                r.status === "warning" ? "\u26a0" : "\u2717";
            // Both chains fall through to the error rendering, so a status
            // without its own branch here renders as a failure.
            const color =
                r.status === "created" ? "green" :
                r.status === "updated" ? "green" :
                r.status === "removed" ? "red" :
                r.status === "already-exists" ? "yellow" :
                r.status === "warning" ? "yellow" : "red";

            return h(Text, { key: i },
                h(Text, { color }, ` ${icon}`),
                h(Text, null, ` ${r.message}`),
            );
        }),
        h(Text, null, " "),
        h(Text, { color: "gray" }, "Press q to exit"),
    );
}
