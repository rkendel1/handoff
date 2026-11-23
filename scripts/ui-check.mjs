#!/usr/bin/env node
// Browser check of Handoff's steering UI against a real Handoff server (FeltKit 0.3.37).
// A delegation is delivered and claimed through the runner's MCP capabilities, and a real FeltKit agent
// task is bound to it (no EVE here: this checks the person's controls and FeltKit's agent control state).
// Writes screenshots and a JSON summary to docs/evidence/ui/.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startGitHubStub } from "../tests/support/github-stub.mjs";
import { handoff } from "../runner/src/mcp.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/evidence/ui"); mkdirSync(out, { recursive: true });
const PORT = 3510; const URL_ = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "✓" : "✗"} ${name} ${detail}`); };

const stub = await startGitHubStub({ token: "ui-token" });
stub.setBranch("main", "base");
const server = spawn("npx", ["feltkit", "dev", "--port", String(PORT)], { cwd: root, env: { ...process.env, GITHUB_API_URL: stub.url, FELTKIT_CREDENTIAL_GITHUB: "ui-token" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = ""; server.stdout.on("data", (b) => (log += b)); server.stderr.on("data", (b) => (log += b));
process.on("exit", () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} });
while (!/Ready in/.test(log)) { if (/✗/.test(log)) throw new Error(log); await sleep(300); }
const session = (id, type, role) => JSON.parse(execFileSync("npx", ["feltkit", "session", "create", "--id", id, "--type", type, "--role", role, "--json"], { cwd: root, encoding: "utf8" })).token;
const ADA = session("ada", "user", "member"); const ADMIN = session("ada", "user", "admin"); const POOL = session("runner-pool", "service", "runner");
const http = async (token, kind, name, args = {}) => { const r = await fetch(`${URL_}/api/${kind}/${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) }); const j = await r.json(); if (!j.ok) throw new Error(JSON.stringify(j.error)); return j.value; };

const repositoryId = await http(ADMIN, "mutation", "admin:addRepository", { owner: "acme", name: "ledger", defaultBranch: "main" });
await http(ADMIN, "mutation", "admin:registerAgent", { key: "coder", name: "Coder", definition: "eve:runner/agent", model: "anthropic:claude-sonnet-5-5" });
const id = await http(ADA, "mutation", "work:create", { title: "Use EU data only", objective: "Rebuild the quarterly report from the EU dataset.", criteria: ["Report renders", "Tests pass"], repositoryId });
await http(ADA, "mutation", "work:assign", { id, agentKey: "coder" });
const pool = handoff(URL_, POOL);
await pool.call("runner.deliver", { delegationId: id });
const c = await pool.call("runner.claim", { delegationId: id, instance: "ui-check", leaseMs: 600_000 });
const task = await pool.call("feltkit.agent.create", { objective: "Use EU data only", playbook: "handoff" });
const taskId = task.task.task_id;
await pool.call("runner.bindtask", { delegationId: id, claim: c.claim, agentTaskId: taskId });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 1300 }, deviceScaleFactor: 2 })).newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("BROWSER", m.text()); });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${URL_}/#work/${id}`);
try { await page.waitForSelector(".agent-control", { timeout: 20_000 }); } catch (e) { await page.screenshot({ path: join(out, "debug.png") }); console.log("BODY", (await page.locator("body").innerText()).slice(0, 800)); throw e; }
await page.waitForSelector(".phase.running");
const panel = page.locator("section.card", { has: page.locator(".agent-control") });
await panel.screenshot({ path: join(out, "01-running.png") });
check("running: Update coming, Pause, Interrupt, Stop enabled", await page.locator('.ctl-bar button[aria-label="Pause"]').isEnabled() && await page.locator('.ctl-bar button[aria-label="Interrupt"]').isEnabled() && await page.locator('.ctl-bar button[aria-label="Stop"]').isEnabled());

// Typing signals "update coming"; the agent keeps working.
await page.locator(".composer textarea").fill("Use EU data only; drop the US figures.");
await page.waitForSelector(".signal-mark.on", { timeout: 10_000 });
await page.waitForSelector(".instructions .badge.signaled", { timeout: 10_000 });
check("typing signals an update (FeltKit instruction state: signaled)", true, await page.locator(".hint").innerText());
await panel.screenshot({ path: join(out, "02-update-coming.png") });
const cp1 = await pool.call("feltkit.agent.checkpoint", { taskId });
check("agent keeps working while an update is only signaled", cp1.proceed === true && cp1.signaled === 1, JSON.stringify({ proceed: cp1.proceed, signaled: cp1.signaled }));

// Send: the same instruction becomes received; the agent takes it at its next checkpoint and acknowledges.
await page.locator('.composer-actions button[aria-label="Send update"]').click();
await page.waitForSelector(".instructions .badge.received", { timeout: 10_000 });
const cp2 = await pool.call("feltkit.agent.checkpoint", { taskId });
check("the update is delivered at the next checkpoint", cp2.instructions.length === 1 && cp2.instructions[0].text === "Use EU data only; drop the US figures.");
await pool.call("feltkit.agent.acknowledge", { taskId, instructionId: cp2.instructions[0].instructionId, outcome: "incorporated", note: "Switched the source to the EU dataset; US figures removed." });
await page.waitForSelector(".instructions .badge.incorporated", { timeout: 10_000 });
check("the agent's acknowledgement appears (incorporated, with its note)", (await page.locator(".instructions").innerText()).includes("Switched the source"));
await panel.screenshot({ path: join(out, "03-incorporated.png") });

// Pause → Resume control swaps; the agent's checkpoint is held.
await page.locator('.ctl-bar button[aria-label="Pause"]').click();
await page.waitForSelector(".phase.paused", { timeout: 10_000 });
check("paused: Resume shown, agent held", await page.locator('.ctl-bar button[aria-label="Resume"]').isVisible() && (await pool.call("feltkit.agent.checkpoint", { taskId })).proceed === false);
await panel.screenshot({ path: join(out, "04-paused.png") });
await page.locator('.ctl-bar button[aria-label="Resume"]').click();
await page.waitForSelector(".phase.running", { timeout: 10_000 });

// Interrupt: Interrupt disabled while interrupted, Resume shown.
await page.locator('.ctl-bar button[aria-label="Interrupt"]').click();
await page.waitForSelector(".phase.interrupted", { timeout: 10_000 });
check("interrupted: Interrupt disabled, Resume shown, agent held", await page.locator('.ctl-bar button[aria-label="Interrupt"]').isDisabled() && await page.locator('.ctl-bar button[aria-label="Resume"]').isVisible() && (await pool.call("feltkit.agent.checkpoint", { taskId })).proceed === false);
await panel.screenshot({ path: join(out, "05-interrupted.png") });

// Stop: confirms, stops the agent task and cancels the delegation; everything disabled.
page.once("dialog", (d) => void d.accept());
await page.locator('.ctl-bar button[aria-label="Stop"]').click();
await page.waitForSelector(".phase.stopped", { timeout: 15_000 });
const st = await pool.call("runner.status", { delegationId: id });
check("stopped: controls disabled; delegation and invocation cancelled", await page.locator('.ctl-bar button[aria-label="Stop"]').isDisabled() && st.state === "cancelled" && st.invocationState === "cancelled", JSON.stringify(st));
await panel.screenshot({ path: join(out, "06-stopped.png") });
const refused = await pool.call("runner.report", { delegationId: id, claim: c.claim, instance: "ui-check", events: [] }).then(() => "accepted", (e) => e.code);
check("the runner's next report is refused after Stop", refused !== "accepted", refused);

await page.goto(`${URL_}/#desk`); await sleep(800); await page.screenshot({ path: join(out, "07-desk.png") });
await browser.close(); await stub.close();
writeFileSync(join(out, "ui-check.json"), JSON.stringify({ ranAt: new Date().toISOString(), feltkit: "0.3.37", results }, null, 2) + "\n");
const ok = results.every((r) => r.ok);
console.log(ok ? "UI CHECK PASS" : "UI CHECK FAIL");
process.exit(ok ? 0 : 1);
