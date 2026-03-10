import { createElement as h } from "react";
import { render } from "ink";
import { App } from "./App.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

render(h(App, { repoRoot }));
