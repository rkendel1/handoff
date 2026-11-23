#!/usr/bin/env node
// Probe: can separate runners hold separate runner-pool sessions that Handoff observes and FeltKit revokes one at a time?
// Against a real Handoff dev server (FeltKit 0.3.37). Writes docs/evidence/session-probe.json.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handoff } from "../runner/src/mcp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3520; const URL_ = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✓" : "✗"} ${name} ${detail}`); };

const server = spawn("npx", ["feltkit", "dev", "--port", String(PORT)], { cwd: root, env: { ...process.env, GITHUB_API_URL: "http://127.0.0.1:9", FELTKIT_CREDENTIAL_GITHUB: "unused" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = ""; server.stdout.on("data", (b) => (log += b)); server.stderr.on("data", (b) => (log += b));
process.on("exit", () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} });
while (!/Ready in/.test(log)) { if (/✗/.test(log)) throw new Error(log); await sleep(300); }
const cli = (...a) => execFileSync("npx", ["feltkit", "session", ...a], { cwd: root, encoding: "utf8" });
const create = (label) => JSON.parse(cli("create", "--id", "runner-pool", "--type", "service", "--role", "runner", "--label", label, "--json"));
const A = create("runner-a"); const B = create("runner-b");
const ADMIN = JSON.parse(cli("create", "--id", "ada", "--type", "user", "--role", "member", "--json")).token;
const http = async (token, kind, name, args = {}) => { const r = await fetch(`${URL_}/api/${kind}/${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) }); return r.json(); };

const hb = (instance) => ({ instance, state: "idle", runtime: { name: "eve", version: "probe", node: process.version }, capabilities: {} });
const a = handoff(URL_, A.token); const b = handoff(URL_, B.token);
await a.call("runner.heartbeat", hb("host-a")); await b.call("runner.heartbeat", hb("host-b"));
const workers = (await http(ADMIN, "query", "admin:listWorkers")).value;
const ref = (i) => workers.find((w) => w.instance === i)?.sessionRef;
check("two sessions for the one runner-pool principal coexist", Boolean(A.token && B.token && A.token !== B.token));
check("Handoff observes a distinct session ref per runner", Boolean(ref("host-a") && ref("host-b") && ref("host-a") !== ref("host-b")), JSON.stringify({ a: ref("host-a"), b: ref("host-b") }));
const listed = cli("list", "--json");
check("the observed refs are FeltKit's session refs", listed.includes(ref("host-a")) && listed.includes(ref("host-b")));

cli("revoke", ref("host-a"));
const refusedA = await a.call("runner.heartbeat", hb("host-a")).then(() => "accepted", (e) => e.code ?? String(e.message));
const acceptedB = await b.call("runner.heartbeat", hb("host-b")).then(() => "accepted", (e) => e.code ?? String(e.message));
check("revoking one runner's session stops that runner only", refusedA !== "accepted" && acceptedB === "accepted", JSON.stringify({ a: refusedA, b: acceptedB }));
let ended = null;
for (let i = 0; i < 20 && !ended; i++) { await sleep(300); ended = (await http(ADMIN, "query", "admin:listWorkers")).value.find((w) => w.instance === "host-a")?.sessionEnded ?? null; }
check("auth.onSessionEnd marks the revoked runner on Agents", ended?.reason === "revoked", JSON.stringify(ended));

mkdirSync(join(root, "docs/evidence"), { recursive: true });
writeFileSync(join(root, "docs/evidence/session-probe.json"), JSON.stringify({ ranAt: new Date().toISOString(), feltkit: "0.3.37", results }, null, 2) + "\n");
const ok = results.every((r) => r.ok);
console.log(ok ? "SESSION PROBE PASS" : "SESSION PROBE FAIL");
process.exit(ok ? 0 : 1);
