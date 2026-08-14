#!/usr/bin/env node

// LSP-aware supervisor for TypeScript 7's native language server. The sibling
// Bash script owns all TypeScript discovery/version policy; this process owns
// the protocol session so it can seed a replacement server after a crash.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const MAX_RECOVERIES = 5;
const RECOVERY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
const MAX_QUEUE_BYTES = 1_048_576;
const MAX_QUEUE_MS = 10_000;
const STDERR_TAIL_BYTES = 4_096;
const INTERNAL_INITIALIZE_ID = "typescript-lsp-recovery-initialize";
const RESOLVER = join(dirname(fileURLToPath(import.meta.url)), "typescript-lsp.sh");


function writeFrame(stream, message) {
    const body = JSON.stringify(message);
    stream.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}


class LspFrameReader {
    #buffer = Buffer.alloc(0);

    push(chunk, onMessage) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (true) {
            const separator = this.#buffer.indexOf("\r\n\r\n");
            if (separator < 0) return;
            const header = this.#buffer.subarray(0, separator).toString("ascii");
            const match = /^Content-Length:\s*(\d+)\s*$/mi.exec(header);
            if (!match) throw new Error("received an LSP frame without Content-Length");
            const bodyLength = Number.parseInt(match[1], 10);
            const end = separator + 4 + bodyLength;
            if (this.#buffer.length < end) return;
            const body = this.#buffer.subarray(separator + 4, end).toString("utf8");
            this.#buffer = this.#buffer.subarray(end);
            onMessage(JSON.parse(body), end);
        }
    }
}


function applyContentChanges(text, changes) {
    let updated = text;
    for (const change of changes) {
        if (!change.range) {
            updated = change.text;
            continue;
        }
        const start = positionOffset(updated, change.range.start);
        const end = positionOffset(updated, change.range.end);
        if (start > end) throw new Error("received an LSP change whose end precedes its start");
        updated = `${updated.slice(0, start)}${change.text}${updated.slice(end)}`;
    }
    return updated;
}


function positionOffset(text, position) {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) {
        throw new Error("received an LSP change with an invalid position");
    }
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
        const newline = text.indexOf("\n", offset);
        if (newline < 0) throw new Error("received an LSP change beyond the document's final line");
        offset = newline + 1;
    }
    const lineEnd = text.indexOf("\n", offset);
    const limit = lineEnd < 0 ? text.length : lineEnd;
    if (offset + position.character > limit) throw new Error("received an LSP change beyond the line ending");
    return offset + position.character;
}


class SessionSnapshot {
    initializeParams = null;
    initialized = false;
    configuration = null;
    initialWorkspaceFolders = new Map();
    workspaceFolders = new Map();
    documents = new Map();

    observeClient(message) {
        const { method, params } = message;
        if (method === "initialize") {
            this.initializeParams = params;
            for (const folder of params?.workspaceFolders ?? []) {
                if (folder?.uri) {
                    this.initialWorkspaceFolders.set(folder.uri, folder);
                    this.workspaceFolders.set(folder.uri, folder);
                }
            }
        }
        if (method === "initialized") this.initialized = true;
        if (method === "workspace/didChangeConfiguration") this.configuration = params;
        if (method === "workspace/didChangeWorkspaceFolders") {
            for (const folder of params?.event?.added ?? []) if (folder?.uri) this.workspaceFolders.set(folder.uri, folder);
            for (const folder of params?.event?.removed ?? []) if (folder?.uri) this.workspaceFolders.delete(folder.uri);
        }
        if (method === "textDocument/didOpen") {
            const document = params?.textDocument;
            if (document?.uri && typeof document.text === "string") this.documents.set(document.uri, { ...document });
        }
        if (method === "textDocument/didChange") {
            const document = this.documents.get(params?.textDocument?.uri);
            if (!document) return;
            document.text = applyContentChanges(document.text, params.contentChanges ?? []);
            document.version = params.textDocument.version;
        }
        if (method === "textDocument/didClose") this.documents.delete(params?.textDocument?.uri);
    }

    replay(server) {
        if (!this.initialized) return;
        writeFrame(server.stdin, { jsonrpc: "2.0", method: "initialized", params: {} });
        if (this.configuration) writeFrame(server.stdin, { jsonrpc: "2.0", method: "workspace/didChangeConfiguration", params: this.configuration });
        const added = [...this.workspaceFolders].filter(([uri]) => !this.initialWorkspaceFolders.has(uri)).map(([, folder]) => folder);
        const removed = [...this.initialWorkspaceFolders].filter(([uri]) => !this.workspaceFolders.has(uri)).map(([, folder]) => folder);
        if (added.length || removed.length) {
            writeFrame(server.stdin, { jsonrpc: "2.0", method: "workspace/didChangeWorkspaceFolders", params: { event: { added, removed } } });
        }
        for (const document of this.documents.values()) {
            writeFrame(server.stdin, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: document } });
        }
    }
}


async function resolveTsc() {
    return new Promise((resolve, reject) => {
        const child = spawn(RESOLVER, ["--check"], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0 && stdout.trim()) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || "TypeScript 7 resolver returned no binary"));
        });
    });
}


class RecoveryProxy {
    snapshot = new SessionSnapshot();
    clientReader = new LspFrameReader();
    serverReader = new LspFrameReader();
    child = null;
    childStderr = "";
    recoveries = 0;
    state = "starting";
    queued = [];
    queuedBytes = 0;
    queueTimer = null;
    stopping = false;
    pendingClientRequests = new Map();
    serverRequests = new Map();
    serverRequestResponses = new Map();
    clientInputHandler = null;

    async start() {
        this.binary = await resolveTsc();
        this.startChild(false);
        this.clientInputHandler = (chunk) => this.receiveClient(chunk);
        process.stdin.on("data", this.clientInputHandler);
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
            process.on(signal, () => this.stop(signal));
        }
    }

    startChild(recovering) {
        this.serverReader = new LspFrameReader();
        this.childStderr = "";
        const child = spawn(this.binary, ["--lsp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
        this.child = child;
        child.stdout.on("data", (chunk) => this.receiveServer(chunk));
        child.stderr.on("data", (chunk) => {
            this.childStderr = `${this.childStderr}${chunk}`.slice(-STDERR_TAIL_BYTES);
        });
        child.on("error", (error) => this.fail(`could not start TypeScript LSP: ${error.message}`));
        child.on("exit", (code, signal) => {
            if (child !== this.child || this.stopping) return;
            this.child = null;
            this.handleExit(code, signal);
        });
        if (recovering) {
            writeFrame(child.stdin, { jsonrpc: "2.0", id: INTERNAL_INITIALIZE_ID, method: "initialize", params: this.snapshot.initializeParams ?? {} });
        }
    }

    receiveClient(chunk) {
        try {
            this.clientReader.push(chunk, (message, byteLength) => this.routeClient(message, byteLength));
        } catch (error) {
            this.fail(`invalid client LSP input: ${error.message}`);
        }
    }

    routeClient(message, byteLength) {
        try {
            this.snapshot.observeClient(message);
            if (message.method === "workspace/didChangeConfiguration") this.serverRequestResponses.clear();
        } catch (error) {
            this.fail(`cannot snapshot client state: ${error.message}`);
            return;
        }
        if (message.method === "exit") {
            this.stop("SIGTERM");
            return;
        }
        if (this.state === "recovering") {
            this.enqueue(message, byteLength);
            return;
        }
        if (!this.child) {
            this.fail("TypeScript LSP was unavailable while processing client traffic");
            return;
        }
        this.recordClientRequest(message);
        writeFrame(this.child.stdin, message);
    }

    receiveServer(chunk) {
        try {
            this.serverReader.push(chunk, (message) => this.routeServer(message));
        } catch (error) {
            this.fail(`invalid TypeScript LSP output: ${error.message}`);
        }
    }

    routeServer(message) {
        if (message.method && message.id !== undefined) {
            this.handleServerRequest(message);
            return;
        }
        if (this.state === "recovering" && message.id === INTERNAL_INITIALIZE_ID) {
            if (message.error) {
                this.fail(`replacement TypeScript LSP rejected initialization: ${message.error.message ?? "unknown error"}`);
                return;
            }
            this.snapshot.replay(this.child);
            this.state = "running";
            this.clearQueueTimer();
            for (const queued of this.queued) writeFrame(this.child.stdin, queued);
            this.queued = [];
            this.queuedBytes = 0;
            return;
        }
        if (message.id !== undefined) this.pendingClientRequests.delete(message.id);
        writeFrame(process.stdout, message);
    }

    recordClientRequest(message) {
        if (message.id === undefined) return;
        const request = this.serverRequests.get(message.id);
        if (request) {
            this.serverRequests.delete(message.id);
            this.serverRequestResponses.set(request, { result: message.result, error: message.error });
            return;
        }
        if (!message.method) return;
        this.pendingClientRequests.set(message.id, message.method);
    }

    handleServerRequest(message) {
        if (!["workspace/configuration", "client/registerCapability", "client/unregisterCapability"].includes(message.method)) {
            this.fail(`unsupported server-to-client request: ${message.method}`);
            return;
        }
        const requestKey = JSON.stringify({ method: message.method, params: message.params ?? null });
        const cached = this.serverRequestResponses.get(requestKey);
        if (cached) {
            writeFrame(this.child.stdin, { jsonrpc: "2.0", id: message.id, ...cached });
            return;
        }
        if (this.state === "recovering") {
            this.fail(`replacement TypeScript LSP requested uncached ${message.method}`);
            return;
        }
        this.serverRequests.set(message.id, requestKey);
        writeFrame(process.stdout, message);
    }

    handleExit(code, signal) {
        const reason = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        const stderr = this.childStderr.trim().replace(/\s+/g, " ");
        this.failPendingClientRequests("TypeScript LSP crashed before completing the request");
        if (this.recoveries >= MAX_RECOVERIES || !this.snapshot.initializeParams) {
            this.fail(`TypeScript LSP stopped (${reason})${stderr ? `: ${stderr}` : ""}`);
            return;
        }
        const delay = RECOVERY_DELAYS_MS[this.recoveries];
        this.recoveries += 1;
        this.state = "recovering";
        process.stderr.write(`typescript-lsp: native server crashed (${reason}); recovery ${this.recoveries}/${MAX_RECOVERIES} in ${delay}ms${stderr ? `: ${stderr}` : ""}\n`);
        this.startQueueTimer();
        setTimeout(() => this.startChild(true), delay);
    }

    enqueue(message, byteLength) {
        this.queued.push(message);
        this.queuedBytes += byteLength;
        if (this.queuedBytes > MAX_QUEUE_BYTES) this.fail("client LSP queue exceeded 1048576 bytes during recovery");
    }

    failPendingClientRequests(message) {
        for (const id of this.pendingClientRequests.keys()) {
            writeFrame(process.stdout, { jsonrpc: "2.0", id, error: { code: -32603, message } });
        }
        this.pendingClientRequests.clear();
    }

    startQueueTimer() {
        this.clearQueueTimer();
        this.queueTimer = setTimeout(() => this.fail("client LSP queue exceeded 10000ms during recovery"), MAX_QUEUE_MS);
    }

    clearQueueTimer() {
        if (this.queueTimer) clearTimeout(this.queueTimer);
        this.queueTimer = null;
    }

    stop(signal) {
        this.stopping = true;
        this.clearQueueTimer();
        if (!this.child) {
            process.exit(0);
            return;
        }
        this.child.once("exit", () => process.exit(0));
        this.child.kill(signal);
    }

    fail(message) {
        if (this.stopping) return;
        this.stopping = true;
        this.clearQueueTimer();
        if (this.clientInputHandler) process.stdin.off("data", this.clientInputHandler);
        process.stdin.pause();
        this.failPendingClientRequests(message);
        for (const queued of this.queued) {
            if (queued.id !== undefined && queued.method) {
                writeFrame(process.stdout, { jsonrpc: "2.0", id: queued.id, error: { code: -32603, message } });
            }
        }
        this.queued = [];
        this.queuedBytes = 0;
        process.stderr.write(`typescript-lsp: ${message}\n`);
        if (this.child) this.child.kill();
        // Force exit: exitCode alone leaves open stdio / child handles alive long enough to hang.
        process.exit(1);
    }
}


const proxy = new RecoveryProxy();
proxy.start().catch((error) => {
    process.stderr.write(`typescript-lsp: ${error.message}\n`);
    process.exitCode = 1;
});
