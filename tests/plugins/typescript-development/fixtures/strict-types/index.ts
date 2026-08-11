type LoadResult =
  | { ok: true; value: { readonly id: string } }
  | { ok: false; kind: "syntax" | "validation"; message: string };

declare function load(): LoadResult;

const result = load();
if (result.ok) {
  result.value.id satisfies string;
  // @ts-expect-error failure details are unavailable on success
  result.message;
} else {
  result.message satisfies string;
  // @ts-expect-error values are unavailable on failure
  result.value;
}

type ToArray<T> = T extends unknown ? T[] : never;
type Distributed = ToArray<string | number>;
const strings: Distributed = ["value"];
const numbers: Distributed = [1];
// @ts-expect-error distribution does not produce a mixed array
const mixed: Distributed = ["value", 1];
void [strings, numbers, mixed];
