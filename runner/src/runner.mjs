#!/usr/bin/env node
// Handoff runner: one process of the trusted runner pool (Node >= 24).
//
// It works delegations through Handoff's capabilities over MCP, as the pool's shared service session
// (HANDOFF_TOKEN). Handoff and FeltKit own every state transition, lease, approval and fact; the runner
// executes and reports. Execution is a real EVE agent (@appport/eve 1.0.2, eve build + eve start) in a
// Docker sandbox with network deny-all. Git happens here, outside the sandbox: the sandbox holds no
// credentials. The runner's instance id is its own label: Handoff records it as asserted evidence.
//
//   HANDOFF_URL=http://localhost:3000 HANDOFF_TOKEN=<runner-pool session> ANTHROPIC_API_KEY=... \
//   HANDOFF_GIT_REMOTE='file:///srv/git/{owner}/{name}.git' node src/runner.mjs [--once] [--lease 30000]
//   Fault injection (tests): --crash-after-pr  exit 137 right after opening the PR, before reporting.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handoff } from "./mcp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const URL_ = process.env.HANDOFF_URL ?? "http://localhost:3000";
const TOKEN = process.env.HANDOFF_TOKEN; if (!TOKEN) throw new Error("HANDOFF_TOKEN (the runner pool's session) is required");
const REMOTE = process.env.HANDOFF_GIT_REMOTE ?? "https://github.com/{owner}/{name}.git";
const LEASE_MS = Number(opt("lease", 30_000));
const HEARTBEAT_MS = Math.max(1_000, Math.floor(LEASE_MS / 4));
const INSTANCE = opt("instance", `${hostname()}-${process.pid}`);
const WORK = join(root, ".work");
const PORT = Number(opt("port", 2600 + (process.pid % 300)));
const h = handoff(URL_, TOKEN);
const log = (...m) => console.log(`[runner ${INSTANCE} ${new Date().toISOString()}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remoteFor = (repo) => REMOTE.replace("{owner}", repo.owner).replace("{name}", repo.name);

/** One attempt's reporting: sequenced events, heartbeat (lease renewal), stop on refusal. */
class Attempt {
  constructor(delegationId, claim) { this.delegationId = delegationId; this.claim = claim; this.seq = 0; this.buffer = []; this.stopped = null; }
  add(kind, text) { this.buffer.push({ seq: ++this.seq, kind, text: String(text).slice(0, 4000), at: Date.now() }); }
  async beat() {
    const events = this.buffer.splice(0, 50);
    try { await h.call("runner.report", { delegationId: this.delegationId, claim: this.claim, instance: INSTANCE, events }); }
    catch (e) { this.buffer.unshift(...events); this.stopped = `${e.code}: ${e.message}`; }
    return !this.stopped;
  }
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  log(`pool session at ${URL_}; lease ${LEASE_MS} ms; instance ids are asserted, not authenticated`);
  for (;;) {
    const next = await h.call("runner.next", {});
    for (const item of next) {
      try { await work(item); } catch (e) { log(`delegation ${item.number}: ${e.code ?? ""} ${e.message}`); }
    }
    if (flag("once") && next.length === 0) return;
    await sleep(2_000);
  }
}

async function work(item) {
  const id = item.id;
  if (item.state === "queued") { const d = await h.call("runner.deliver", { delegationId: id }); log(`#${item.number} delivered (${d.invocationId}${d.replayed ? ", replayed" : ""})`); }
  let c;
  if (item.state === "awaiting_approval") {
    // Another runner asked for approval and is gone: resume once the person approved, then recover.
    const claim = await resumeAfterApproval(id, { wait: false });
    if (!claim) return;
    c = { claim, attemptNumber: "resumed", previous: [{ attempt: "awaiting_approval", outcome: "handed over" }], snapshot: await h.call("runner.snapshot", { delegationId: id }) };
  } else {
    c = await h.call("runner.claim", { delegationId: id, instance: INSTANCE, leaseMs: LEASE_MS });
    if (!c.proceed) { log(`#${item.number} not claimed: ${c.reason}`); return; }
  }
  const snap = c.snapshot;
  const a = new Attempt(id, c.claim);
  log(`#${snap.delegation.number} claimed: attempt ${c.attemptNumber}; previous ${JSON.stringify(c.previous)}`);
  const beat = setInterval(() => void a.beat(), HEARTBEAT_MS);
  try {
    // Steering: a FeltKit agent task, linked to the delegation, that people can steer.
    let taskId = snap.delegation.agentTaskId;
    if (!taskId) {
      const created = await h.call("feltkit.agent.create", { objective: `#${snap.delegation.number}: ${snap.delegation.title}`, playbook: "handoff" });
      taskId = created.task?.task_id ?? created.task_id;
      await h.call("runner.bindtask", { delegationId: id, claim: c.claim, agentTaskId: taskId });
    }
    const repo = snap.repository; const branch = snap.delegation.branch;
    const dir = join(WORK, `d${snap.delegation.number}-a${c.attemptNumber}-${process.pid}`);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const clone = join(dir, "repo");
    execFileSync("git", ["clone", "--quiet", remoteFor(repo), clone]);

    // Recovery: what does the outside world already show? (GitHub and the remote branch.)
    let head = null;
    const remoteHead = (() => { try { return git(clone, "rev-parse", `origin/${branch}`); } catch { return null; } })();
    if (c.previous.length || snap.prFacts.length) {
      const pr = await h.call("github.observe", { delegationId: id });
      a.add("progress", `recovery: previous attempts ${JSON.stringify(c.previous)}; remote branch ${remoteHead ?? "absent"}; GitHub PR ${pr ? `#${pr.number} at ${pr.headSha}` : "none"}`);
      if (remoteHead) head = remoteHead; // a previous attempt's pushed work is reused, not redone
    }
    if (!head) {
      try { head = await execute({ snap, a, taskId, clone, branch, dir }); }
      catch (e) {
        // A deterministic execution error is reported as a failure, not abandoned to lease expiry
        // (which would make the pool retry it forever).
        a.add("error", `execution failed: ${e.message}`.slice(0, 2000)); await a.beat();
        await h.call("runner.fail", { delegationId: id, claim: a.claim, code: "EXECUTION_ERROR", message: String(e.message).slice(0, 500), effect: "none" }).catch((x) => log(`could not report failure: ${x.message}`));
        throw e;
      }
    }
    if (!head || a.stopped) return;
    a.add("progress", `branch ${branch} at ${head}`);
    await a.beat();

    // Consequential effect: the delegating person approves opening the PR for exactly this head.
    let claim = c.claim;
    const inv = (await h.call("runner.snapshot", { delegationId: id })).invocation;
    const approved = inv?.approval?.decision && inv.approval.input?.branch === branch && inv.approval.input?.headSha === head;
    if (!approved) {
      await h.call("runner.requestapproval", { delegationId: id, claim, branch, headSha: head, title: snap.delegation.title });
      log(`#${snap.delegation.number} waiting for the person's approval to open a PR at ${head.slice(0, 12)}`);
      clearInterval(beat);
      claim = await resumeAfterApproval(id, { wait: true });
      if (!claim) return;
      a.claim = claim;
    }
    const opened = await h.call("runner.openpullrequest", { delegationId: id, claim, headSha: head, body: `Delegated work #${snap.delegation.number} via Handoff.\n\n${snap.delegation.objective}` });
    log(`#${snap.delegation.number} pull request: ${JSON.stringify(opened)}`);
    if (flag("crash-after-pr")) { log("FAULT INJECTION: exiting before reporting the result"); process.exit(137); }
    if (opened.created === null) { await h.call("runner.fail", { delegationId: id, claim, code: "PR_OUTCOME_UNKNOWN", message: opened.message, effect: "possible" }); return; }
    await h.call("runner.submit", { delegationId: id, claim, instance: INSTANCE, summary: a.summary ?? `Branch ${branch} at ${head}; PR #${opened.prNumber}.`, headSha: head });
    log(`#${snap.delegation.number} reported (verification by Handoff follows)`);
  } finally { clearInterval(beat); }
}

/** Wait for the person's decision; FeltKit refuses resume (NOT_APPROVED) until then. Returns the new claim. */
async function resumeAfterApproval(id, { wait = false } = {}) {
  for (;;) {
    try {
      const r = await h.call("runner.resume", { delegationId: id, instance: INSTANCE, leaseMs: LEASE_MS });
      if (r.proceed) return r.claim;
      if (!wait) return null;
    } catch (e) {
      if (e.code !== "NOT_APPROVED" || !wait) { if (e.code !== "NOT_APPROVED") log(`resume refused: ${e.code} ${e.message}`); return null; }
    }
    const st = await h.call("runner.status", { delegationId: id });
    if (["cancelled", "failed"].includes(st.state) || st.invocationState === "failed") return null;
    await sleep(2_000);
  }
}

/** Run the EVE agent on the objective. Returns the pushed head commit, or null if stopped. */
async function execute({ snap, a, taskId, clone, branch, dir }) {
  const project = join(dir, "eve");
  cpSync(join(root, "agent"), project, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes("/.eve") && !p.includes("/.output") });
  symlinkSync(join(root, "agent", "node_modules"), join(project, "node_modules"));
  cpSync(clone, join(project, "agent/sandbox/workspace"), { recursive: true, filter: (p) => !p.includes("/.git") });
  // EVE's CLI runs on this runner's Node (>= 24), not whatever `node` is first on PATH.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  delete env.ANTHROPIC_BASE_URL; delete env.AI_GATEWAY_API_KEY; delete env.HANDOFF_TOKEN;
  const eve = join(project, "node_modules/.bin/eve");
  a.add("progress", "building the EVE agent"); await a.beat();
  execFileSync(eve, ["build"], { cwd: project, env, stdio: "ignore", timeout: 600_000 });
  const before = new Set(containers());
  const server = spawn(eve, ["start", "--host", "127.0.0.1", "--port", String(PORT)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let serverLog = ""; server.stdout.on("data", (b) => (serverLog += b)); server.stderr.on("data", (b) => (serverLog += b));
  const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} };
  process.on("exit", stop);
  try {
    const t0 = Date.now();
    while (!/listening at http/.test(serverLog)) { if (Date.now() - t0 > 180_000) throw new Error("EVE server did not start"); await sleep(500); }
    const base = `http://127.0.0.1:${PORT}/eve/v1`;
    const d = snap.delegation;
    const prompt = `${d.objective}\n\nAcceptance criteria:\n${(d.criteria.length ? d.criteria : ["Existing tests pass"]).map((c) => `- ${c}`).join("\n")}\n\nThe repository is in /workspace. Run \`npm test\`. Finish without asking questions, then summarize.`;
    const session = await (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: prompt }) })).json();
    a.add("progress", `EVE session ${session.sessionId} started`);
    let next = 0; let started = 0; let settled = 0; let lastOutcome = null; let quietSince = 0; let lastText = ""; let interrupted = false; let held = false;
    for (;;) {
      if (a.stopped) { a.add("warning", `stopping: ${a.stopped}`); await fetch(`${base}/session/${session.sessionId}/cancel`, { method: "POST" }).catch(() => {}); return null; }
      // New EVE events → Handoff observations (a bounded catch-up read; no live stream to hold).
      const res = await fetch(`${base}/session/${session.sessionId}/stream?startIndex=${next}&includeTailIndex=1`);
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue; const ev = JSON.parse(line); if (ev.$eve) continue; next++;
        for (const f of ev.facts ?? []) {
          if (f.type === "turn.started") started++;
          if (f.type === "turn.settled") { settled++; lastOutcome = f.data?.outcome; }
          if (f.type === "call.requested") a.add(/test/.test(String(f.data?.input?.command ?? "")) ? "test" : f.data?.input?.command ? "command" : "tool", f.data?.input?.command ?? `${f.data?.capability?.name ?? "tool"} ${JSON.stringify(f.data?.input ?? {}).slice(0, 300)}`);
          if (f.type === "call.settled" && typeof f.data?.output?.exitCode === "number" && f.data.output.exitCode !== 0) a.add("warning", `exit ${f.data.output.exitCode}: ${String(f.data.output.stderr ?? "").slice(0, 300)}`);
          if (f.type === "content.completed" && f.data?.kind !== "reasoning" && f.data?.value) { lastText = String(f.data.value); a.add("message", lastText); }
        }
      }
      // Steering (FeltKit agent control): take updates at this boundary and pass them to the session.
      const cp = await h.call("feltkit.agent.checkpoint", { taskId });
      for (const ins of cp.instructions ?? []) {
        await fetch(`${base}/session/${session.sessionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: `Update from ${ins.from}: ${ins.text}` }) });
        await h.call("feltkit.agent.acknowledge", { taskId, instructionId: ins.instructionId, outcome: "incorporated", note: "Delivered to the EVE session; it is taken into account from the agent's next step." });
        a.add("progress", `instruction from ${ins.from} delivered to the agent: ${ins.text}`);
      }
      // Interrupt: cancel the running model step now (EVE session cancel); hold until a person resumes.
      if (cp.mode === "interrupted" && !interrupted) {
        interrupted = true;
        if (started > settled) await fetch(`${base}/session/${session.sessionId}/cancel`, { method: "POST" }).catch(() => {});
        a.add("warning", `interrupted by a person${cp.reason ? ` (${cp.reason})` : ""}: the current model step was cancelled`);
      }
      if (cp.mode === "paused" && !held) { held = true; a.add("progress", `paused by a person${cp.reason ? ` (${cp.reason})` : ""}: no new step starts; a step already running finishes (EVE cannot pause mid-step)`); }
      if (cp.proceed && (interrupted || held)) {
        a.add("progress", "resumed by a person");
        if (interrupted && settled >= started) await fetch(`${base}/session/${session.sessionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "A person resumed you after an interruption. Continue the task from where you stopped." }) });
        interrupted = false; held = false;
      }
      const st = await h.call("runner.status", { delegationId: d.id });
      if (st.state === "cancelled" || st.invocationState === "cancelled") a.stopped = "cancelled by the delegator";
      const idle = started > 0 && settled >= started && !(cp.instructions ?? []).length && !interrupted;
      if (idle && !cp.proceed) { quietSince = 0; a.add("progress", "paused by a person: holding before committing"); }
      else if (idle) { quietSince ||= Date.now(); if (Date.now() - quietSince > 3_000) break; }
      else quietSince = 0;
      await sleep(1_500);
    }
    if (lastOutcome !== "completed") { a.add("error", `EVE turn ended ${lastOutcome}`); await h.call("runner.fail", { delegationId: d.id, claim: a.claim, code: "AGENT_TURN_FAILED", message: `EVE turn ${lastOutcome}`, effect: "none" }); a.stopped = "failed"; return null; }
    a.summary = lastText.slice(0, 3_500);
    // Copy the sandbox workspace out, commit and push (outside the sandbox).
    const mine = containers().filter((c) => !before.has(c));
    if (mine.length !== 1) throw new Error(`expected one new sandbox container, found ${mine.length}`);
    const out = join(dir, "out");
    execFileSync("docker", ["cp", `${mine[0]}:/workspace/.`, out]);
    for (const c of mine) { try { execFileSync("docker", ["rm", "-f", c], { stdio: "ignore" }); } catch {} }
    git(clone, "checkout", "-q", "-B", branch, `origin/${d.baseBranch}`);
    cpSync(out, clone, { recursive: true, filter: (p) => !p.includes("/.eve") && !p.includes("node_modules") });
    git(clone, "add", "-A");
    if (!git(clone, "status", "--porcelain")) { a.add("warning", "the agent made no changes"); await h.call("runner.fail", { delegationId: d.id, claim: a.claim, code: "NO_CHANGES", message: "The agent made no changes.", effect: "none" }); a.stopped = "no changes"; return null; }
    execFileSync("git", ["-c", "user.name=Handoff runner", "-c", "user.email=runner@handoff.invalid", "commit", "-q", "-m", `#${d.number} ${d.title}\n\nDelegated via Handoff (attempt by ${INSTANCE}).`], { cwd: clone });
    git(clone, "push", "-q", "origin", `${branch}:refs/heads/${branch}`);
    return git(clone, "rev-parse", "HEAD");
  } finally {
    stop();
    writeFileSync(join(dir, "eve-server.log"), serverLog.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]"));
  }
}

const containers = () => execFileSync("docker", ["ps", "-aq", "--filter", "name=eve-sbx-"], { encoding: "utf8" }).split("\n").filter(Boolean);

if (existsSync(join(root, "agent", "node_modules")) === false) { console.error("Run `npm run setup` in runner/ first (installs the EVE agent's dependencies)."); process.exit(2); }
main().catch((e) => { log(`stopped: ${e.code ?? ""} ${e.message}`); process.exit(e.code === "UNAUTHORIZED" ? 3 : 1); });
