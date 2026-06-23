import { createElement as h } from "react";
import { Box, Text } from "ink";

interface SectionHeaderProps {
    label: string;
    status: "ON" | "OFF" | "UPGRADE" | "REMOVE";
}

const STATUS_COLOR: Record<SectionHeaderProps["status"], string> = {
    REMOVE: "red",
    UPGRADE: "yellow",
    ON: "green",
    OFF: "gray",
};

export function SectionHeader({ label, status }: SectionHeaderProps) {
    return h(Box, { marginTop: 1 },
        h(Text, { bold: true }, label + " "),
        h(Text, { color: STATUS_COLOR[status], dimColor: status === "OFF" }, status),
    );
}
