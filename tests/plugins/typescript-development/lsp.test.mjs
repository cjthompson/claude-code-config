import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN = join(ROOT, "plugins/typescript-development");
const PLUGINS = join(ROOT, "plugins");
const WRAPPER = join(PLUGIN, "scripts/typescript-lsp.mjs");
const CRASHING_LSP = join(ROOT, "tests", "plugins", "typescript-development", "fixtures", "crashing-lsp.mjs");


async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}


test("plugin owns exactly one .lsp.json keyed by language", async () => {
    const config = await readJson(join(PLUGIN, ".lsp.json"));
    assert.deepEqual(Object.keys(config), ["typescript"]);
    const typescript = config.typescript;
    assert.equal(typescript.command, "node");
    assert.deepEqual(typescript.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/typescript-lsp.mjs"]);
    assert.equal(typescript.transport, "stdio");
    assert.deepEqual(typescript.extensionToLanguage, {
        ".ts": "typescript",
        ".tsx": "typescript",
        ".mts": "typescript",
        ".cts": "typescript",
    });
    assert.equal(typescript.maxRestarts, 3);
});


test("typescript-lsp wrapper script exists and parses", async () => {
    assert.equal((await stat(WRAPPER)).isFile(), true);
    const head = await readFile(WRAPPER, "utf8");
    assert.ok(head.startsWith("#!/usr/bin/env node"), "wrapper must use node shebang");
    const check = spawnSync(process.execPath, ["--check", WRAPPER], { encoding: "utf8" });
    assert.equal(check.status, 0, `node --check failed:\n${check.stderr}`);
});


test("lsp args resolve from the plugin root, never the subprocess cwd", async () => {
    const config = await readJson(join(PLUGIN, ".lsp.json"));
    const [scriptArg] = config.typescript.args;
    // A bare relative path resolves against the LSP subprocess's working
    // directory, which is the user's project, not the plugin. That yields
    // MODULE_NOT_FOUND and three failed restarts everywhere except this repo.
    assert.ok(
        scriptArg.startsWith("${CLAUDE_PLUGIN_ROOT}/"),
        `lsp args must be plugin-rooted, got: ${scriptArg}`,
    );
    assert.ok(!scriptArg.includes("plugins/typescript-development"), "path must be plugin-relative");
});


test("wrapper has no argv[1] entry guard", async () => {
    const source = await readFile(WRAPPER, "utf8");
    // Node realpath-resolves import.meta.url but not argv[1], so such a guard
    // is false under any symlinked or aliased invocation. main() then never
    // runs and the process exits 0 having written nothing — a silent,
    // undiagnosable LSP failure. Strip comments so prose about the bug (in the
    // wrapper or here) cannot satisfy or trip this check.
    const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/argv\s*\[\s*1\s*\]/.test(code), "wrapper must not gate main() on argv[1]");
});


test("Node recovery proxy delegates TypeScript discovery to the Bash resolver", async () => {
    const source = await readFile(WRAPPER, "utf8");
    assert.match(source, /typescript-lsp\.sh/);
    assert.match(source, /\["--check"\]/);
});


/** Drive a wrapper path with one framed `initialize` request; resolve what it wrote. */
function probeLsp(scriptPath) {
    return new Promise((accept) => {
        const child = spawn(process.execPath, [scriptPath], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            accept({ stdout, stderr });
        };
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            // Stop as soon as the server has answered; no need to wait out the timeout.
            if (/Content-Length: \d+/.test(stdout)) finish();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            if (/could not locate a TypeScript 7 binary/.test(stderr)) finish();
        });
        const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { processId: process.pid, rootUri: `file://${tmpdir()}`, capabilities: {} },
        });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        const timer = setTimeout(finish, 15000);
        child.on("error", finish);
        child.on("exit", finish);
    });
}


function encodeFrame(message) {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}


function decodeFrames(output) {
    const messages = [];
    let remaining = Buffer.from(output);
    while (remaining.length > 0) {
        const separator = remaining.indexOf("\r\n\r\n");
        if (separator < 0) break;
        const header = remaining.subarray(0, separator).toString("ascii");
        const match = /^Content-Length: (\d+)$/mi.exec(header);
        if (!match) break;
        const end = separator + 4 + Number.parseInt(match[1], 10);
        if (remaining.length < end) break;
        messages.push(JSON.parse(remaining.subarray(separator + 4, end).toString("utf8")));
        remaining = remaining.subarray(end);
    }
    return messages;
}


function directTscChild(wrapperPid) {
    try {
        const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
        return output.split("\n")
            .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
            .filter(Boolean)
            .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
            .find((processInfo) => processInfo.ppid === wrapperPid && processInfo.command.includes("tsc --lsp --stdio"));
    } catch (error) {
        if (error.code === "EPERM") return null;
        throw error;
    }
}


async function waitForLspMessage(getOutput, predicate, label, timeoutMs = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const message = decodeFrames(getOutput()).find(predicate);
        if (message) return message;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
}


test("wrapper restores an unsaved document after the native server crashes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "ts-lsp-recovery-"));
    const statePath = join(scratch, "launches");
    const child = spawn(process.execPath, [WRAPPER], {
        cwd: scratch,
        env: { ...process.env, TS_LSP_BIN: CRASHING_LSP, TS_LSP_FIXTURE_STATE: statePath },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    try {
        child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
        child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "initialized", params: {} }));
        await new Promise((resolvePromise, reject) => {
            const timeout = setTimeout(() => reject(new Error(`timed out waiting for dynamic registration; stderr: ${stderr}`)), 3_000);
            const observe = () => {
                const request = decodeFrames(stdout).find((message) => message.method === "client/registerCapability");
                if (!request) return;
                clearTimeout(timeout);
                resolvePromise(request);
            };
            child.stdout.on("data", observe);
            observe();
        }).then((request) => {
            child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result: null }));
        });
        child.stdin.write(encodeFrame({
            jsonrpc: "2.0",
            method: "textDocument/didOpen",
            params: { textDocument: { uri: "file:///recovery.ts", languageId: "typescript", version: 1, text: "let value = 1;" } },
        }));
        child.stdin.write(encodeFrame({
            jsonrpc: "2.0",
            id: 2,
            method: "textDocument/hover",
            params: { textDocument: { uri: "file:///recovery.ts" }, position: { line: 0, character: 0 } },
        }));
        child.stdin.write(encodeFrame({
            jsonrpc: "2.0",
            method: "textDocument/didChange",
            params: {
                textDocument: { uri: "file:///recovery.ts", version: 2 },
                contentChanges: [{ range: { start: { line: 0, character: 12 }, end: { line: 0, character: 13 } }, text: "2" }],
            },
        }));

        await new Promise((resolvePromise, reject) => {
            const timeout = setTimeout(() => reject(new Error(`timed out waiting for recovery; stderr: ${stderr}`)), 3_000);
            const observe = () => {
                const replay = decodeFrames(stdout).find((message) => message.method === "fixture/replayed");
                if (!replay) return;
                clearTimeout(timeout);
                resolvePromise(replay);
            };
            child.stdout.on("data", observe);
            child.on("exit", () => observe());
        }).then((replay) => {
            assert.equal(replay.params.textDocument.text, "let value = 2;");
        });
        await new Promise((resolvePromise, reject) => {
            const timeout = setTimeout(() => reject(new Error(`timed out waiting for queued request; stderr: ${stderr}`)), 3_000);
            const observe = () => {
                const response = decodeFrames(stdout).find((message) => message.id === 2);
                if (!response) return;
                clearTimeout(timeout);
                resolvePromise(response);
            };
            child.stdout.on("data", observe);
            observe();
        }).then((response) => assert.deepEqual(response.result, { contents: "recovered" }));
        assert.equal(decodeFrames(stdout).every((message) => message.jsonrpc === "2.0"), true, `stdout contained non-LSP output: ${stdout}`);
    } finally {
        child.kill();
        await rm(scratch, { recursive: true, force: true });
    }
});


test("wrapper exits when the client ends the LSP session", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "ts-lsp-exit-"));
    const child = spawn(process.execPath, [WRAPPER], {
        cwd: scratch,
        env: { ...process.env, TS_LSP_BIN: CRASHING_LSP },
        stdio: ["pipe", "pipe", "pipe"],
    });
    try {
        child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
        child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "initialized", params: {} }));
        child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }));
        child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "exit", params: null }));
        const result = await new Promise((resolvePromise, reject) => {
            const timeout = setTimeout(() => reject(new Error("wrapper did not exit after LSP exit notification")), 1_000);
            child.on("exit", (code, signal) => {
                clearTimeout(timeout);
                resolvePromise({ code, signal });
            });
        });
        assert.equal(result.signal, null);
        assert.equal(result.code, 0);
    } finally {
        child.kill();
        await rm(scratch, { recursive: true, force: true });
    }
});


test("wrapper recovers a real TypeScript 7 server after a live child kill", async (t) => {
    const resolver = join(PLUGIN, "scripts", "typescript-lsp.sh");
    const available = spawnSync(resolver, ["--check"], { encoding: "utf8" });
    if (available.status !== 0) {
        t.skip("TypeScript 7 is not installed on this machine");
        return;
    }

    const scratch = await mkdtemp(join(tmpdir(), "ts-lsp-live-recovery-"));
    const child = spawn(process.execPath, [WRAPPER], { cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const answeredServerRequestIds = new Set();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const write = (message) => child.stdin.write(encodeFrame(message));
    const answerServerRequests = () => {
        for (const message of decodeFrames(stdout)) {
            if (!message.method || message.id === undefined || answeredServerRequestIds.has(message.id)) continue;
            answeredServerRequestIds.add(message.id);
            write({
                jsonrpc: "2.0",
                id: message.id,
                result: message.method === "workspace/configuration" ? [] : null,
            });
        }
    };

    try {
        write({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                processId: process.pid,
                rootUri: `file://${scratch}`,
                capabilities: { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } } },
            },
        });
        await waitForLspMessage(() => stdout, (message) => message.id === 1 && message.result, "real initialize response");
        write({ jsonrpc: "2.0", method: "initialized", params: {} });
        write({
            jsonrpc: "2.0",
            method: "textDocument/didOpen",
            params: { textDocument: { uri: `file://${scratch}/probe.ts`, languageId: "typescript", version: 1, text: "const probe: number = 1;\n" } },
        });
        write({
            jsonrpc: "2.0",
            method: "textDocument/didChange",
            params: {
                textDocument: { uri: `file://${scratch}/probe.ts`, version: 2 },
                contentChanges: [{ range: { start: { line: 0, character: 22 }, end: { line: 0, character: 23 } }, text: "2" }],
            },
        });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        answerServerRequests();
        const server = directTscChild(child.pid);
        if (!server) {
            t.skip("process inspection is unavailable in this sandbox");
            return;
        }
        process.kill(server.pid, "SIGKILL");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        answerServerRequests();
        assert.match(stderr, /recovery 1\/5 in 250ms/, "wrapper must report the real child crash");
        const replacement = directTscChild(child.pid);
        assert.ok(replacement && replacement.pid !== server.pid, "wrapper must start a replacement tsc process");
        write({
            jsonrpc: "2.0",
            id: 2,
            method: "textDocument/hover",
            params: { textDocument: { uri: `file://${scratch}/probe.ts` }, position: { line: 0, character: 7 } },
        });
        await waitForLspMessage(() => {
            answerServerRequests();
            return stdout;
        }, (message) => message.id === 2 && ("result" in message || "error" in message), `post-recovery hover response; stderr: ${stderr}; messages: ${JSON.stringify(decodeFrames(stdout))}`);
    } finally {
        child.kill("SIGTERM");
        await rm(scratch, { recursive: true, force: true });
    }
});


test("wrapper speaks LSP from a foreign cwd and through a symlinked path", async (t) => {
    const direct = await probeLsp(WRAPPER);
    if (/could not locate a TypeScript 7 binary/.test(direct.stderr)) {
        t.skip("TypeScript 7 not installed on this machine");
        return;
    }

    assert.match(direct.stdout, /Content-Length: \d+/, "wrapper must respond when run from another cwd");

    const scratch = await mkdtemp(join(tmpdir(), "ts-lsp-symlink-"));
    try {
        const linkedDir = join(scratch, "linked");
        await symlink(join(PLUGIN, "scripts"), linkedDir);
        const { stdout, stderr } = await probeLsp(join(linkedDir, "typescript-lsp.mjs"));
        // Regression: the old argv[1] guard made this branch emit zero bytes
        // and exit 0, which a "file exists and parses" test cannot catch.
        assert.match(stdout, /Content-Length: \d+/, `no LSP output via symlink; stderr: ${stderr}`);
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
});


test("single-owner rule: only python-scripting and typescript-development may carry .lsp.json", async () => {
    const entries = await readdir(PLUGINS, { withFileTypes: true });
    const owners = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(PLUGINS, entry.name, ".lsp.json");
        try {
            await stat(candidate);
            owners.push(entry.name);
        } catch {
            // not present, ignore
        }
    }
    assert.deepEqual(owners.sort(), ["python-scripting", "typescript-development"].sort());
});
