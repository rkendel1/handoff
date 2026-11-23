/**
 * Product areas added from the T3 reference: layered timeline with trust, source-control evidence,
 * runtime/session mirroring, runner heartbeats, execution policy, the attention Desk and connection checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, approve, boot, claimAs, delegated, lin, sleep } from "./support/setup.js";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; details?: { reason?: string } }) => e.details?.reason ?? e.code ?? "ERROR");
const CAPS = { steer: "next-step", pause: "between-steps", interrupt: "cancel-generation", resume: "continue", stop: "cooperative", reconnect: "none" };

test("timeline keeps layers distinct and labels trust; attempts nest sessions and turns from runner reports", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    await ctx.runner.mutation(api.runner.report, {
      delegationId: id, claim: a.claim!, instance: "r1",
      events: [
        { seq: 1, kind: "progress", text: "reading code", at: Date.now(), session: "s-1", turn: "t-1" },
        { seq: 2, kind: "tool", text: "bash: npm test", at: Date.now(), session: "s-1", turn: "t-1", status: "completed" },
        { seq: 3, kind: "message", text: "editing format.ts", at: Date.now(), session: "s-1", turn: "t-2" },
      ],
      runtime: { session: "s-1", turn: "t-2", mode: "running", capabilities: CAPS },
    });
    // Duplicate delivery of the same events is ignored (at-least-once reporting).
    const again = await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [{ seq: 2, kind: "tool", text: "bash: npm test", at: Date.now(), session: "s-1", turn: "t-1" }] });
    assert.deepEqual([again.accepted, again.duplicates], [0, 1]);

    const tl = await ctx.person.query(api.work.timeline, { id });
    assert.equal(tl.attempts.length, 1);
    const [att] = tl.attempts;
    assert.equal(att!.instance, "r1");
    assert.equal(att!.instanceAuthenticated, false, "runner instance ids are never presented as authenticated");
    assert.deepEqual(att!.sessions.map((s: any) => [s.session, s.turns.map((t: any) => [t.turn, t.events])]), [["s-1", [["t-1", 2], ["t-2", 1]]]]);

    const by = (title: string) => tl.entries.find((e: any) => e.title === title)!;
    assert.deepEqual([by("delegation.created").trust, by("delegation.created").layer], ["decided", "delegation"]);
    assert.deepEqual([by("attempt.started").trust, by("attempt.started").layer], ["reported", "attempt"]);
    assert.deepEqual([by("session.started").trust, by("session.started").layer], ["reported", "session"]);
    const activity = tl.entries.filter((e: any) => e.layer === "activity");
    assert.equal(activity.length, 3);
    assert.ok(activity.every((e: any) => e.trust === "reported" && e.source === "runner"));
    for (let i = 1; i < tl.entries.length; i++) assert.ok(tl.entries[i - 1]!.at <= tl.entries[i]!.at, "entries are in time order");

    // The runtime mirror on the delegation (what the UI uses to enable controls) is the latest report.
    const d = (await ctx.person.query(api.work.detail, { id })).delegation;
    assert.deepEqual([d.runtime?.instance, d.runtime?.session, d.runtime?.turn, d.runtime?.mode, d.runtime?.capabilities.reconnect], ["r1", "s-1", "t-2", "running", "none"]);
  } finally { await ctx.close(); }
});

test("source-control evidence comes from GitHub reads: diff, commits, checks and reviews, labelled observed", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "head111");
    ctx.stub.setFiles("head111", [{ filename: "src/format.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }]);
    ctx.stub.setChecks([{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "in_progress", conclusion: null }]);
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "head111", title: "Fix" });
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    const opened = (await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "head111", body: "x" })) as { prNumber: number };
    ctx.stub.setReviews(opened.prNumber, [{ state: "CHANGES_REQUESTED", user: { login: "rev" }, submitted_at: new Date().toISOString() }]);

    // Lin (a member, not the delegator) may ask Handoff to read; what is recorded is GitHub's answer.
    await ctx.t.as("lin").mutation(api.github.observeSourceControlNow, { delegationId: id });
    const facts = (await ctx.person.query(api.work.detail, { id })).facts;
    const latest = (k: string) => facts.filter((f) => f.kind === k).reduce((a: any, f) => (!a || f.observedAt >= a.observedAt ? f : a), null);
    assert.deepEqual(latest("diff").detail.files.map((f: any) => [f.filename, f.additions, f.deletions, f.truncated]), [["src/format.ts", 3, 1, false]]);
    assert.equal(latest("diff").detail.base, "base000");
    assert.deepEqual(latest("commits").detail.commits, [{ sha: "head111", message: "Delegated change" }]);
    assert.equal(latest("checks").state, "pending");
    assert.deepEqual([latest("reviews").state, latest("reviews").prNumber, latest("reviews").detail.reviews[0].by], ["changes_requested", opened.prNumber, "rev"]);

    // Reading again with nothing changed records nothing new; a changed check does.
    const before = facts.length;
    await ctx.person.mutation(api.github.observeSourceControlNow, { delegationId: id });
    assert.equal((await ctx.person.query(api.work.detail, { id })).facts.length, before);
    ctx.stub.setChecks([{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "failure" }]);
    await ctx.person.mutation(api.github.observeSourceControlNow, { delegationId: id });
    const after = (await ctx.person.query(api.work.detail, { id })).facts;
    assert.equal(after.length, before + 1);
    assert.equal(after.filter((f) => f.kind === "checks").reduce((a: any, f) => (!a || f.observedAt >= a.observedAt ? f : a), null).state, "failing");

    const tl = await ctx.person.query(api.work.timeline, { id });
    assert.ok(tl.entries.filter((e: any) => e.title.startsWith("github.") && e.title.endsWith(".observed")).every((e: any) => e.trust === "observed"));
  } finally { await ctx.close(); }
});

test("execution policy: attempts are bounded at the claim boundary; only people may change it, within FeltKit's bounds", async () => {
  const ctx = await boot();
  try {
    assert.equal(await code(ctx.runner.mutation(api.admin.setPolicy, { maxAttempts: 1, leaseMinMs: 1000, leaseMaxMs: 60_000 })), "FORBIDDEN");
    assert.equal(await code(ctx.t.as("lin").mutation(api.admin.setPolicy, { maxAttempts: 1, leaseMinMs: 1000, leaseMaxMs: 60_000 })), "FORBIDDEN");
    assert.equal(await code(ctx.person.mutation(api.admin.setPolicy, { maxAttempts: 0, leaseMinMs: 1000, leaseMaxMs: 60_000 })), "INVALID_ARGUMENT");
    assert.equal(await code(ctx.person.mutation(api.admin.setPolicy, { maxAttempts: 2, leaseMinMs: 5000, leaseMaxMs: 1000 })), "INVALID_ARGUMENT");
    await ctx.person.mutation(api.admin.setPolicy, { maxAttempts: 1, leaseMinMs: 1000, leaseMaxMs: 60_000 });
    const s = await ctx.person.query(api.admin.settings);
    assert.deepEqual([s.policy.maxAttempts, s.policy.updatedBy], [1, "ada"]);

    const { id } = await delegated(ctx);
    // The runner asks for a 10 ms lease; the policy's floor (1 s) applies.
    const a = await claimAs(ctx, id, "r1", 10);
    assert.equal(a.proceed, true);
    assert.equal((await claimAs(ctx, id, "r2")).proceed, false, "a live lease is not taken over");
    await sleep(1300);
    const b = await claimAs(ctx, id, "r2");
    assert.deepEqual([b.proceed, b.reason], [false, "ATTEMPTS_EXHAUSTED"]);
    const d = (await ctx.person.query(api.work.detail, { id })).delegation;
    assert.deepEqual([d.state, d.failure?.code], ["failed", "ATTEMPTS_EXHAUSTED"]);
    const desk = await ctx.person.query(api.work.desk);
    assert.ok(desk.failedOrUncertain.some((r: any) => r.id === id && /Stopped after 1 attempts/.test(r.reason)));
  } finally { await ctx.close(); }
});

test("runner heartbeats are recorded as self-reported; the pool cannot write people's records", async () => {
  const ctx = await boot();
  try {
    const hb = { instance: "host-a#1", state: "idle" as const, runtime: { name: "eve", version: "1.0.2", node: "v24.1.0" }, capabilities: CAPS };
    await ctx.runner.mutation(api.runner.heartbeat, hb);
    await ctx.runner.mutation(api.runner.heartbeat, { ...hb, state: "working", delegationId: "d1", session: "s-9" });
    const workers = await ctx.t.as("lin").query(api.admin.listWorkers);
    assert.equal(workers.length, 1, "one row per instance, updated in place");
    assert.deepEqual([workers[0]!.state, workers[0]!.session, workers[0]!.capabilities.pause, workers[0]!.capabilities.reconnect], ["working", "s-9", "between-steps", "none"]);
    // Unknown capability values are normalized to "none" rather than trusted.
    await ctx.runner.mutation(api.runner.heartbeat, { ...hb, capabilities: { ...CAPS, pause: "teleport" } });
    assert.equal((await ctx.person.query(api.admin.listWorkers))[0]!.capabilities.pause, "none");
    // A person cannot pose as a runner.
    assert.equal(await code(ctx.t.as("lin").mutation(api.runner.heartbeat, hb)), "FORBIDDEN");
  } finally { await ctx.close(); }
});

test("the Desk groups work by the reason it needs attention, for the signed-in person", async () => {
  const ctx = await boot();
  try {
    const draft = await ctx.person.mutation(api.work.create, { title: "Draft only", objective: "Nothing yet assigned here.", criteria: [], repositoryId: ctx.repositoryId });
    const { id: paused } = await delegated(ctx, "Paused work");
    const p = await claimAs(ctx, paused, "r1");
    await ctx.runner.mutation(api.runner.report, { delegationId: paused, claim: p.claim!, instance: "r1", events: [], runtime: { mode: "paused", capabilities: CAPS } });
    const { id: approving, invocationId } = await delegated(ctx, "Needs approval");
    const q = await claimAs(ctx, approving, "r2");
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: approving, claim: q.claim!, branch: q.snapshot!.delegation.branch, headSha: "x1", title: "t" });
    const { id: queued } = await delegated(ctx, "Queued");

    const desk = await ctx.person.query(api.work.desk);
    const ids = (k: string) => (desk as any)[k].map((r: any) => r.id);
    assert.deepEqual(ids("awaitingAssignment"), [draft]);
    assert.deepEqual(ids("waitingForInput"), [paused]);
    assert.deepEqual(ids("awaitingApproval"), [approving]);
    assert.ok(ids("active").includes(queued));
    assert.match(desk.awaitingApproval[0]!.reason, /asks you to approve/);
    // Another member sees the same work, framed as someone else's decision.
    const linDesk = await ctx.t.as("lin").query(api.work.desk);
    assert.match(linDesk.awaitingApproval[0]!.reason, /Waiting for ada/);
    assert.equal(linDesk.awaitingApproval[0]!.mine, false);
    void invocationId; void lin;
  } finally { await ctx.close(); }
});

test("a connection check reads the repository from GitHub and records the outcome", async () => {
  const ctx = await boot();
  try {
    const ok = (await ctx.person.mutation(api.admin.checkConnection, { repositoryId: ctx.repositoryId })) as { ok: boolean; fullName?: string };
    assert.deepEqual([ok.ok, ok.fullName], [true, "acme/ledger"]);
    ctx.stub.setStatus(502);
    const bad = (await ctx.person.mutation(api.admin.checkConnection, { repositoryId: ctx.repositoryId })) as { ok: boolean; error?: string };
    ctx.stub.setStatus(null);
    assert.equal(bad.ok, false);
    const c = (await ctx.person.query(api.admin.settings)).connections.find((x) => x.repositoryId === ctx.repositoryId)!;
    assert.ok(c.lastOkAt && c.lastErrorAt && c.lastErrorAt >= c.lastOkAt && c.lastError);
    assert.equal(await code(ctx.t.as("lin").mutation(api.admin.checkConnection, { repositoryId: ctx.repositoryId })), "FORBIDDEN");
  } finally { await ctx.close(); }
});

test("credential-shaped text from runners is masked before it is stored", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const leaky = "push failed: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/acme/ledger.git; ANTHROPIC sk-ant-api03-abcdefghijklmnopqrstuv; Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
    await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [{ seq: 1, kind: "error", text: leaky, at: Date.now() }] });
    await ctx.runner.mutation(api.runner.heartbeat, { instance: "r1", state: "working", runtime: { name: "eve", version: "1", node: "v24" }, capabilities: CAPS, lastError: leaky });
    await ctx.runner.mutation(api.runner.failAttempt, { delegationId: id, claim: a.claim!, code: "runner.fail", message: leaky, effect: "none" });
    const stored = JSON.stringify(await ctx.person.query(api.work.detail, { id })) + JSON.stringify(await ctx.person.query(api.admin.listWorkers));
    for (const secret of ["ghs_abcdefghijklmnopqrstuvwxyz0123", "sk-ant-api03-abcdefghijklmnopqrstuv", "abcdefghijklmnopqrstuvwxyz123456"]) assert.ok(!stored.includes(secret), `${secret.slice(0, 6)}… is not stored`);
    assert.match(stored, /https:\/\/\[redacted\]@github\.com/);
    assert.match(stored, /Bearer \[redacted\]/);
  } finally { await ctx.close(); }
});

test("an approval decision is recorded in Handoff from FeltKit's record, not from the caller", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    // Nothing decided yet: nothing is recorded.
    assert.equal(((await ctx.person.mutation(api.work.recordApprovalDecision, { id })) as { recorded: boolean }).recorded, false);
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch: a.snapshot!.delegation.branch, headSha: "s1", title: "t" });
    assert.equal(((await ctx.person.mutation(api.work.recordApprovalDecision, { id })) as { recorded: boolean }).recorded, false);
    await approve(ctx, invocationId);
    // FeltKit shows the invocation only to the person it is for (and its deliverer), so another member cannot record it.
    assert.equal(await code(ctx.t.as("lin").mutation(api.work.recordApprovalDecision, { id })), "NOT_FOUND");
    const r = (await ctx.person.mutation(api.work.recordApprovalDecision, { id })) as { recorded: boolean; outcome?: string };
    assert.deepEqual([r.recorded, r.outcome], [true, "approved"]);
    assert.equal(((await ctx.person.mutation(api.work.recordApprovalDecision, { id })) as { recorded: boolean }).recorded, false, "recorded once");
    const entry = (await ctx.person.query(api.work.timeline, { id })).entries.find((e: any) => e.title === "approval.decided")!;
    assert.deepEqual([entry.layer, entry.trust, (entry.detail as any).by], ["decision", "decided", "ada"], "the approver comes from FeltKit's record; the call carries no decision");
    assert.equal(await code(ctx.runner.mutation(api.work.recordApprovalDecision, { id })), "FORBIDDEN");
  } finally { await ctx.close(); }
});

test("tool calls link start to settlement by EVE call id, and usage keeps its provenance", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const at = Date.now();
    const u = (input: number, output: number, costUsd?: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, ...(costUsd === undefined ? {} : { costUsd }) });
    await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [
      { seq: 1, kind: "command", text: "npm test", at, status: "running", callId: "call_1" },
      { seq: 2, kind: "command", text: "npm run build", at, status: "running", callId: "call_2" },
      { seq: 3, kind: "command", text: "npm test → exit 0", at, status: "completed", callId: "call_1" },
      { seq: 4, kind: "usage", text: "usage", at, usage: u(1000, 200, 0.012) },
      { seq: 5, kind: "usage", text: "usage", at, usage: u(500, 100) },
    ] });
    const [att] = (await ctx.person.query(api.work.timeline, { id })).attempts as any[];
    assert.deepEqual(att.openCalls.map((c: any) => c.callId), ["call_2"], "only the call with no settlement is open");
    assert.deepEqual([att.usage.inputTokens, att.usage.outputTokens, att.usage.reports, att.usage.reportsWithCost], [1500, 300, 2, 1]);
    assert.equal(Math.round(att.usage.costUsd * 1000), 12, "cost sums only what the provider reported");
    // A second delegation whose reports carry no cost: the total is absent, not zero.
    const { id: id2 } = await delegated(ctx, "No cost reported");
    const b = await claimAs(ctx, id2, "r2");
    await ctx.runner.mutation(api.runner.report, { delegationId: id2, claim: b.claim!, instance: "r2", events: [{ seq: 1, kind: "usage", text: "usage", at, usage: u(10, 2) }] });
    const [att2] = (await ctx.person.query(api.work.timeline, { id: id2 })).attempts as any[];
    assert.deepEqual([att2.usage.costUsd, att2.usage.reportsWithCost], [null, 0]);
  } finally { await ctx.close(); }
});

test("a pull request closed on GitHub without merging is never verified or accepted, and no second PR is opened", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "c1");
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "c1", title: "t" });
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "c1", body: "x" });
    await ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: r.claim, instance: "r1", summary: "done", headSha: "c1" });
    assert.equal(((await ctx.person.mutation(api.github.verify, { delegationId: id })) as { verified: boolean }).verified, true);
    // A reviewer closes the PR on GitHub without merging.
    ctx.stub.pulls[0]!.state = "closed";
    const again = (await ctx.person.mutation(api.github.verify, { delegationId: id })) as { verified: boolean; reason?: string };
    assert.deepEqual([again.verified, again.reason], [false, "the pull request was closed on GitHub without merging"]);
    assert.equal(await code(ctx.person.mutation(api.work.review, { id, decision: "accepted", note: "ship it" })), "FAILED_PRECONDITION");
    assert.equal(ctx.stub.counts.pullsCreated, 1, "no second PR");
    // Request changes: a new generation, a new branch.
    await ctx.person.mutation(api.work.review, { id, decision: "returned", note: "Reopened as a fresh attempt" });
    const d = (await ctx.person.query(api.work.detail, { id })).delegation;
    assert.deepEqual([d.state, d.generation, d.branch.endsWith("-g2")], ["queued", 2, true]);
  } finally { await ctx.close(); }
});
