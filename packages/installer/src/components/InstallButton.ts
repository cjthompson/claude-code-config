import { createElement as h } from "react";
import { Box, Text } from "ink";

interface InstallButtonProps {
    focused: boolean;
    disabled: boolean;
}

export function InstallButton({ focused, disabled }: InstallButtonProps) {
    const label = disabled ? "Nothing to install" : "Install Selected";
    const bgColor = focused && !disabled ? "cyan" : undefined;
    const textColor = focused && !disabled ? "black" : disabled ? "gray" : "white";

    return h(Box, { justifyContent: "center", marginTop: 1 },
        h(Text, {
            color: textColor,
            backgroundColor: bgColor,
            bold: focused && !disabled,
        }, ` [ ${label} ] `),
    );
}
