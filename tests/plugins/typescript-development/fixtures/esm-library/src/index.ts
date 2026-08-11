import { prefix } from "./internal.js";

export function greet(name: string): string {
  return `${prefix}, ${name}`;
}
