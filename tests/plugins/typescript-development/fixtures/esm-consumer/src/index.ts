import { greet } from "fixture-package";

greet("consumer") satisfies string;

// @ts-expect-error package exports intentionally block deep imports
import "fixture-package/dist/internal.js";
