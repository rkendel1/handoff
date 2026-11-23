#!/usr/bin/env node
// Live recovery scenario with real processes: a Handoff server (FeltKit 0.3.37, Node 22), a GitHub-API
// stub backed by a real bare git repository (no real GitHub writes are authorized), and two separate
// runner processes (Node >= 24) executing a real EVE agent in a Docker sandbox with a real model.
//
// Runner A works the delegation, a person steers it and approves the PR, A opens the PR (GitHub
// creates it; the connection drops before an answer), and A crashes before reporting. The lease expires;
// runner B (same trusted pool identity, another instance) takes over, finds A's PR and pushed branch,
// does not create a duplicate, and reports. Handoff verifies against "GitHub"; the person accepts.
//
//   RUNNER_NODE=/path/to/node24 ANTHROPIC_API_KEY=... node scripts/live-recovery.mjs
// Writes docs/evidence/live-recovery.json (no secrets).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startGitHubStub } from "../tests/support/github-stub.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_NODE = process.env.RUNNER_NODE ?? "node";
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for the runner's EVE agent");
const PORT = Number(process.env.HANDOFF_PORT ?? 3500);
const URL_ = `http://localhost:${PORT}`;
const LEASE = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const timeline = [];
const mark = (step, data = {}) => { const e = { t: Math.round((Date.now() - t0) / 1000), step, ...data }; timeline.push(e); console.log(`[live +${e.t}s] ${step}`, Object.keys(data).length ? JSON.stringify(data).slice(0, 300) : ""); };

// ── A "GitHub" repository: a bare git repo seeded with the fixture, served by the stub. ──
const tmp = mkdtempSync(join(tmpdir(), "handoff-live-"));
const bare = join(tmp, "git", "acme", "ledger.git");
mkdirSync(dirname(bare), { recursive: true });
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
const seed = join(tmp, "seed"); cpSync(join(root, "scripts", "fixture"), seed, { recursive: true });
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-q", "-m", "ledgerlite"], ["push", "-q", bare, "main"]]) execFileSync("git", a, { cwd: seed });
const GH_TOKEN = `live-${Math.random().toString(36).slice(2)}`;
const stub = await startGitHubStub({ bareRepo: bare, token: GH_TOKEN });
stub.dropNextCreate(); // the first PR create is applied, then the connection drops (unknown outcome)
mark("github stub up", { url: stub.url, bareRepo: true });

// ── Handoff (FeltKit dev server, Node 22). ──
const server = spawn("npx", ["feltkit", "dev", "--port", String(PORT)], { cwd: root, env: { ...process.env, GITHUB_API_URL: stub.url, FELTKIT_CREDENTIAL_GITHUB: GH_TOKEN, HANDOFF_POLL_MS: "3000" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let serverLog = ""; server.stdout.on("data", (b) => (serverLog += b)); server.stderr.on("data", (b) => (serverLog += b));
const children = [server];
const cleanup = () => { for (const c of children) { try { process.kill(-c.pid, "SIGKILL"); } catch {} } };
process.on("exit", cleanup);
while (!/Ready in/.test(serverLog)) { if (/✗/.test(serverLog)) throw new Error(serverLog); await sleep(500); }
const session = (id, type, role) => JSON.parse(execFileSync("npx", ["feltkit", "session", "create", "--id", id, "--type", type, "--role", role, "--json"], { cwd: root, encoding: "utf8" })).token;
const ADA = session("ada", "user", "member"); // the delegator
const ADA_ADMIN = session("ada", "user", "admin");
const POOL = session("runner-pool", "service", "runner");
mark("handoff up; sessions issued", { feltkit: "0.3.37" });

async function http(token, kind, name, args = {}) {
  const r = await fetch(`${URL_}/api/${kind}/${encodeURIComponent(name)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) });
  const j = await r.json(); if (!r.ok || j.ok === false) throw new Error(`${name}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`); return j.value ?? j.result ?? j;
}
const post = async (token, path, body) => { const r = await fetch(`${URL_}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

// ── The person delegates. ──
const repositoryId = await http(ADA_ADMIN, "mutation", "admin:addRepository", { owner: "acme", name: "ledger", defaultBranch: "main" });
await http(ADA_ADMIN, "mutation", "admin:registerAgent", { key: "coder", name: "Coder", definition: "eve:runner/agent", model: "anthropic:claude-sonnet-5-5" });
const id = await http(ADA, "mutation", "work:create", { title: "Fix negative money formatting", objective: "formatMoney prints negative amounts as $-5.00; they must print as -$5.00, including amounts under one dollar (-5 cents is -$0.05). Fix src/money.js.", criteria: ["formatMoney(-500) === '-$5.00'", "formatMoney(-5) === '-$0.05'", "npm test passes"], repositoryId });
await http(ADA, "mutation", "work:assign", { id, agentKey: "coder" });
mark("delegated and assigned", { delegationId: id });

function runner(name, extra = []) {
  const p = spawn(RUNNER_NODE, [join(root, "runner/src/runner.mjs"), "--instance", name, "--lease", String(LEASE), "--port", name === "runner-A" ? "2701" : "2702", ...extra], { cwd: join(root, "runner"), env: { ...process.env, HANDOFF_URL: URL_, HANDOFF_TOKEN: POOL, HANDOFF_GIT_REMOTE: `file://${join(tmp, "git")}/{owner}/{name}.git` }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  children.push(p);
  p.stdout.on("data", (b) => process.stdout.write(b)); p.stderr.on("data", (b) => process.stderr.write(b));
  return { p, exit: new Promise((r) => p.on("exit", (code, signal) => r({ code, signal }))) };
}
const detail = () => http(ADA, "query", "work:detail", { id });

// ── Runner A. ──
const A = runner("runner-A", ["--crash-after-pr"]);
mark("runner A started (fault: crash after PR)");
let d; let steered = false;
for (;;) {
  d = await detail();
  if (!steered && d.delegation.agentTaskId && d.events.length > 2) {
    const task = d.delegation.agentTaskId;
    const sig = await post(ADA, `/api/agent/tasks/${task}/control/signal`, { note: "typing an update" });
    mark("person signals: update coming", { status: sig.status, state: sig.body.instruction?.state });
    const r = await post(ADA, `/api/agent/tasks/${task}/control/submit`, { text: "Please also add a test case for -5 cents.", instructionId: sig.body.instruction?.instructionId });
    mark("person submits the update", { status: r.status, state: r.body.instruction?.state, sameInstruction: r.body.instruction?.instructionId === sig.body.instruction?.instructionId });
    steered = true;
  }
  if (d.delegation.state === "awaiting_approval" && d.invocation?.approval && !d.invocation.approval.decision) break;
  if (["failed", "cancelled"].includes(d.delegation.state)) throw new Error(`unexpected ${d.delegation.state}: ${JSON.stringify(d.delegation.failure)}`);
  await sleep(1_500);
}
const approval = d.invocation.approval;
mark("approval requested by runner A", { action: approval.action, input: approval.input });
const approved = await post(ADA, `/api/invocations/${d.delegation.invocationId}/approve`, { digest: approval.digest, note: "Open the PR" });
mark("person approves", { status: approved.status, approvedBy: approved.body.invocation?.approval?.decision?.approvedBy });
const aExit = await A.exit;
mark("runner A exited", aExit);
d = await detail();
mark("state after A's crash", { state: d.delegation.state, report: d.delegation.report ?? null, pullsOnGitHub: stub.pulls.length, createRequests: stub.counts.createRequests, unknownWrite: d.facts.some((f) => f.kind === "unknown_write") });

// ── Runner B, after A's lease expires. ──
mark("waiting for runner A's lease to expire", { leaseMs: LEASE });
await sleep(LEASE + 2_000);
const B = runner("runner-B", ["--once"]);
mark("runner B started");
for (;;) { d = await detail(); if (["reported", "verified", "failed"].includes(d.delegation.state)) break; await sleep(2_000); }
mark("runner B finished", { state: d.delegation.state, report: d.delegation.report });
// Verification: the github.sync job queued at submit (runs as the pool) should verify on its own;
// if it has not within 20 s, the person presses "Check GitHub now".
for (let i = 0; i < 10 && d.delegation.state !== "verified"; i++) { await sleep(2_000); d = await detail(); }
if (d.delegation.state !== "verified") { mark("job did not verify in time; person checks GitHub now"); await http(ADA, "mutation", "github:verify", { delegationId: id }); }
d = await detail();
mark("verification", { state: d.delegation.state, verified: d.delegation.verified ?? null });
await http(ADA, "mutation", "work:review", { id, decision: "accepted", note: "Reviewed the diff on the PR." });
d = await detail();
await B.exit.catch(() => {});

// ── Evidence. ──
const diff = execFileSync("git", ["--git-dir", bare, "diff", "main", d.delegation.branch], { encoding: "utf8" });
const controlView = d.delegation.agentTaskId ? (await (await fetch(`${URL_}/api/agent/tasks/${d.delegation.agentTaskId}/control`, { headers: { authorization: `Bearer ${ADA}` } })).json()).control : null;
const evidence = {
  steering: controlView && controlView.instructions.map((i) => ({ state: i.state, text: i.text, from: i.from, history: i.history.map((x) => `${x.state} by ${x.by}`), resolution: i.resolution })),
  scenario: "live crash-after-PR recovery (S2/S4 combined)", ranAt: new Date().toISOString(), feltkit: "0.3.37", eve: "@appport/eve 1.0.2", model: process.env.HANDOFF_MODEL ?? "claude-sonnet-5-5",
  github: "local GitHub-API stub over a real bare git repository (real GitHub writes not authorized)",
  timeline,
  result: { finalState: d.delegation.state, pullRequestsOnGitHub: stub.pulls.length, createRequestsReceived: stub.counts.createRequests, reported: d.delegation.report, verified: d.delegation.verified, review: d.delegation.review },
  history: d.history.map((h) => ({ seq: h.seq, type: h.type, actor: h.actor, source: h.data?.source, instance: h.data?.instance, data: h.data })),
  facts: d.facts, runnerEvents: d.events.map((e) => ({ attempt: e.attempt, instance: e.instance, seq: e.seq, kind: e.kind, text: e.text.slice(0, 200), ...(e.status ? { status: e.status } : {}), ...(e.callId ? { callId: e.callId } : {}), ...(e.usage ? { usage: e.usage } : {}), ...(e.session ? { session: e.session } : {}), ...(e.turn ? { turn: e.turn } : {}) })),
  attempts: (await http(ADA, "query", "work:timeline", { id })).attempts.map((a) => ({ attempt: a.attempt, how: a.how, instance: a.instance, sessionRef: a.sessionRef, sessions: a.sessions, usage: a.usage, openCalls: a.openCalls })),
  invocation: { attempts: d.invocation?.executions?.[0]?.attempts?.map((a) => ({ id: a.id, outcome: a.outcome, worker: a.worker })), approval: d.invocation?.approval && { action: d.invocation.approval.action, decision: d.invocation.approval.decision } },
  branchDiff: diff,
};
const text = JSON.stringify(evidence, null, 2).replaceAll(GH_TOKEN, "[redacted]").replaceAll(process.env.ANTHROPIC_API_KEY, "[redacted]").replaceAll(POOL, "[redacted]").replaceAll(ADA, "[redacted]");
mkdirSync(join(root, "docs/evidence"), { recursive: true });
writeFileSync(join(root, "docs/evidence/live-recovery.json"), text + "\n");
const ok = d.delegation.state === "accepted" && stub.pulls.length === 1 && stub.counts.createRequests === 1 && aExit.code === 137;
mark(ok ? "PASS" : "FAIL", evidence.result);
cleanup(); await stub.close();
process.exit(ok ? 0 : 1);
