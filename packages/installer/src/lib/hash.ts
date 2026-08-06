import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** SHA-256 hash of a file's contents. */
export async function fileHash(filePath: string): Promise<string> {
    const data = await readFile(filePath);
    return createHash("sha256").update(data).digest("hex");
}
