#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";


const statePath = process.env.TS_LSP_FIXTURE_STATE;
let input = Buffer.alloc(0);
let initialized = false;
let crashed = false;
let launch = 0;

if (process.argv.includes("--version")) {
    process.stdout.write("Version 7.0.2\n");
    process.exit(0);
}

if (statePath) {
    try {
        launch = Number.parseInt(await readFile(statePath, "utf8"), 10) || 0;
    } catch {
        // First launch has no state file.
    }
    launch += 1;
    await appendFile(statePath, `${launch}\n`);
}


function send(message) {
    const body = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}


function receive(message) {
    if (message.method === "initialize") {
        initialized = true;
        send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
        return;
    }
    if (!initialized) return;

    if (message.method === "initialized") {
        send({
            jsonrpc: "2.0",
            id: `register-${launch}`,
            method: "client/registerCapability",
            params: { registrations: [{ id: "fixture-watch", method: "workspace/didChangeWatchedFiles" }] },
        });
        return;
    }

    if (launch === 1 && message.method === "textDocument/didChange" && !crashed) {
        crashed = true;
        process.stderr.write("fixture crash after didChange\n");
        process.exit(9);
    }
    if (launch > 1 && message.method === "textDocument/didOpen") {
        send({ jsonrpc: "2.0", method: "fixture/replayed", params: message.params });
        return;
    }
    if (message.method === "textDocument/hover") {
        send({ jsonrpc: "2.0", id: message.id, result: { contents: "recovered" } });
    }
}


process.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (true) {
        const separator = input.indexOf("\r\n\r\n");
        if (separator < 0) return;
        const header = input.subarray(0, separator).toString("ascii");
        const match = /^Content-Length: (\d+)$/mi.exec(header);
        if (!match) process.exitCode = 2;
        if (!match) return;
        const length = Number.parseInt(match[1], 10);
        const end = separator + 4 + length;
        if (input.length < end) return;
        const body = input.subarray(separator + 4, end).toString("utf8");
        input = input.subarray(end);
        receive(JSON.parse(body));
    }
});
