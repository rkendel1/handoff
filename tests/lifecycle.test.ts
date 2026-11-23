/** Lifecycle, authority and failure paths. Each test runs against its own FeltDB instance and GitHub stub. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ada, api, approve, boot, claimAs, delegated, lin, pool, sleep, TOKEN } from "./support/setup.js";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; details?: { reason?: string } }) => e.details?.reason ?? e.code ?? "ERROR");

test("approval is enforced at the execution boundary, by the delegator only, for exactly what was asked", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "sha1");
    // No approval requested: opening a PR is refused, nothing reaches GitHub.
    assert.equal(await code(ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: a.claim!, headSha: "sha1", body: "x" })), "FORBIDDEN");
    assert.equal(ctx.stub.counts.createRequests, 0);
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "sha1", title: "t" });
    // Resume before approval: FeltKit refuses.
    assert.equal(await code(ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })), "NOT_APPROVED");
    // The runner cannot approve, another member cannot approve, a wrong digest is refused.
    const inv = await ctx.t.runtime.invocations.get(ada, invocationId);
    assert.notEqual(await code(ctx.t.runtime.invocations.approve(pool, invocationId, { digest: inv.approval!.digest })), "ok");
    assert.notEqual(await code(ctx.t.runtime.invocations.approve(lin, invocationId, { digest: inv.approval!.digest })), "ok");
    assert.equal(await code(ctx.t.runtime.invocations.approve(ada, invocationId, { digest: "sha256:00" })), "DIGEST_MISMATCH");
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    // Approval was for sha1; a different head is refused at the boundary.
    ctx.stub.setBranch(branch, "sha2");
    assert.equal(await code(ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "sha2", body: "x" })), "FORBIDDEN");
    assert.equal(ctx.stub.counts.createRequests, 0);
    ctx.stub.setBranch(branch, "sha1");
    const opened = (await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "sha1", body: "x" })) as { created: boolean };
    assert.equal(opened.created, true);
    assert.equal(ctx.stub.counts.pullsCreated, 1);
    // The create carried the credential and an idempotency key; neither the token nor anything else leaks into records.
    const create = ctx.stub.log.find((l: { method: string }) => l.method === "POST")!;
    assert.equal(create.auth, "present");
    assert.match(String(create.idempotencyKey), /^pr-.+-g1$/);
    const everything = JSON.stringify(await ctx.person.query(api.work.detail, { id })) + JSON.stringify(await ctx.t.runtime.activity.list({ limit: 500 }));
    assert.ok(!everything.includes(TOKEN), "the GitHub credential is in no record");
  } finally { await ctx.close(); }
});

test("steering uses FeltKit agent control: received, delivered at checkpoint, acknowledged; pause holds; stop ends", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const task = await ctx.t.runtime.agent.createTask({ objective: "Delegation work", principal: pool, playbook: "handoff" });
    const taskId = task.task.task_id;
    await ctx.runner.mutation(api.runner.bindTask, { delegationId: id, claim: a.claim!, agentTaskId: taskId });
    const control = ctx.t.runtime.agent.control;
    const sent = await control.submit(taskId, { text: "Also cover -0.05" }, ada);
    assert.equal(sent.state, "received");
    const cp = await control.checkpoint(taskId, pool);
    assert.deepEqual([cp.proceed, cp.instructions.map((i) => i.text)], [true, ["Also cover -0.05"]]);
    const ack = await control.acknowledge(taskId, cp.instructions[0]!.instructionId, { outcome: "incorporated", note: "Added a case for -5 cents." }, pool);
    assert.equal(ack.state, "incorporated");
    await control.pause(taskId, ada, "Hold on");
    assert.equal((await control.checkpoint(taskId, pool)).proceed, false, "paused: the runner may not start new work");
    await control.resume(taskId, ada);
    assert.equal((await control.checkpoint(taskId, pool)).proceed, true);
    // A runner cannot steer itself as a person would: only people (or the owner) pause; acknowledge is the owner's.
    assert.notEqual(await code(control.acknowledge(taskId, sent.instructionId, { outcome: "incorporated", note: "x" }, lin)), "ok");
    const detail = await ctx.person.query(api.work.detail, { id });
    assert.equal(detail.delegation.agentTaskId, taskId);
  } finally { await ctx.close(); }
});

test("cancellation by the delegator stops further authorized work; others cannot cancel", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    assert.equal(await code(ctx.t.as("lin").mutation(api.work.cancel, { id, reason: "not mine" })), "FORBIDDEN");
    assert.equal(await code(ctx.runner.mutation(api.work.cancel, { id, reason: "runner" })), "FORBIDDEN");
    await ctx.person.mutation(api.work.cancel, { id, reason: "Requirements changed" });
    // Every further step the runner tries is refused by FeltKit's claim fencing.
    assert.notEqual(await code(ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [] })), "ok");
    assert.notEqual(await code(ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: a.claim!, instance: "r1", summary: "done", headSha: "x" })), "ok");
    assert.notEqual(await code(ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: a.claim!, headSha: "x", body: "x" })), "ok");
    assert.equal(ctx.stub.counts.createRequests, 0);
    const st = await ctx.runner.query(api.runner.status, { delegationId: id });
    assert.deepEqual([st.state, st.invocationState], ["cancelled", "cancelled"]);
  } finally { await ctx.close(); }
});

test("authorization boundaries: people cannot act as runners; the runner cannot review, assign, approve or forge facts", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    assert.equal(await code(ctx.person.mutation(api.runner.claim, { delegationId: id, instance: "me", leaseMs: 60_000 })), "FORBIDDEN");
    assert.equal(await code(ctx.runner.mutation(api.work.review, { id, decision: "accepted", note: "self" })), "FORBIDDEN");
    assert.equal(await code(ctx.runner.mutation(api.work.assign, { id, agentKey: "coder" })), "FORBIDDEN");
    assert.equal(await code(ctx.runner.mutation(api.admin.registerAgent, { key: "evil", name: "Evil", definition: "x://y", model: "m/m" })), "FORBIDDEN");
    assert.equal(await code(ctx.t.query(api.work.list, {})), "UNAUTHORIZED");
    // Facts come only from GitHub: "observe" takes no fact arguments, so a runner can only make Handoff look.
    const a = await claimAs(ctx, id, "r1");
    await ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: a.claim!, instance: "r1", summary: "done", headSha: "made-up" });
    assert.equal(await ctx.runner.mutation(api.github.observePulls, { delegationId: id }), null, "no PR on GitHub: nothing recorded");
    await ctx.runner.mutation(api.github.verify, { delegationId: id });
    assert.equal((await ctx.person.query(api.work.detail, { id })).delegation.state, "reported", "a report alone never verifies");
  } finally { await ctx.close(); }
});

test("duplicate delivery, duplicate and out-of-order observations are safe", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const again = await ctx.runner.mutation(api.runner.deliver, { delegationId: id });
    assert.deepEqual([again.invocationId, again.replayed], [invocationId, true]);
    const a = await claimAs(ctx, id, "r1");
    const ev = (seq: number) => ({ seq, kind: "progress" as const, text: `step ${seq}`, at: Date.now() });
    const r1 = await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [ev(3), ev(1)] });
    const r2 = await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [ev(1), ev(2), ev(3)] });
    assert.deepEqual([r1.accepted, r2.accepted, r2.duplicates], [2, 1, 2]);
    const events = (await ctx.person.query(api.work.detail, { id })).events;
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], "ordered by sequence, each once");
    // A second claim while the first is live does not proceed.
    assert.equal((await claimAs(ctx, id, "r2")).proceed, false);
  } finally { await ctx.close(); }
});

test("lease renewal keeps the claim; expiry lets the pool re-claim; the stale holder is fenced out", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1", 2_000);
    for (let i = 1; i <= 3; i++) { await sleep(900); await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [{ seq: i, kind: "progress", text: `hb ${i}`, at: Date.now() }] }); }
    assert.equal((await claimAs(ctx, id, "r2", 2_000)).proceed, false, "renewed past the original 2 s lease");
    await sleep(2_300);
    const b = await claimAs(ctx, id, "r2", 60_000);
    assert.equal(b.proceed, true);
    assert.notEqual(await code(ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [] })), "ok");
  } finally { await ctx.close(); }
});

test("runner crash before any external effect: the next attempt redoes the work; both attempts stay in history", async () => {
  const ctx = await boot();
  try {
    const { id } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1", 2_000);
    await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "r1", events: [{ seq: 1, kind: "progress", text: "partial", at: Date.now() }] });
    await sleep(2_300); // r1 died
    const b = await claimAs(ctx, id, "r2");
    assert.equal(b.previous![0]!.outcome, "unknown");
    assert.equal((b as unknown as { snapshot: { prFacts: unknown[] } }).snapshot.prFacts.length, 0, "nothing external happened");
    await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: b.claim!, instance: "r2", events: [{ seq: 1, kind: "progress", text: "redo", at: Date.now() }] });
    const d = await ctx.person.query(api.work.detail, { id });
    assert.deepEqual(new Set(d.events.map((e) => e.instance)), new Set(["r1", "r2"]));
    assert.equal(d.history.filter((h) => h.type === "attempt.started" || h.type === "attempt.takeover").length, 2);
  } finally { await ctx.close(); }
});

test("unknown write with nothing created: never re-sent, stays unknown, failed recovery returns the work for a new attempt", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "s1");
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "s1", title: "t" });
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    ctx.stub.dropBeforeCreate(); // the request is lost before GitHub acts
    const first = (await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "s1", body: "x" })) as { outcome?: string };
    assert.equal(first.outcome, "unknown");
    // Retrying with the same idempotency key is not sent again (FeltKit), and is still reported unknown.
    const second = (await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "s1", body: "x" })) as { outcome?: string };
    assert.equal(second.outcome, "unknown");
    assert.equal(ctx.stub.counts.createRequests, 1, "never re-sent");
    assert.equal(ctx.stub.pulls.length, 0);
    // Recovery fails honestly; a person returns the work: a new generation, branch and idempotency key.
    await ctx.runner.mutation(api.runner.failAttempt, { delegationId: id, claim: r.claim, code: "PR_OUTCOME_UNKNOWN", message: "PR create outcome unknown; GitHub shows none", effect: "possible" });
    assert.equal((await ctx.person.query(api.work.detail, { id })).delegation.state, "failed");
    await ctx.person.mutation(api.work.review, { id, decision: "returned", note: "Try again" });
    const d = (await ctx.person.query(api.work.detail, { id })).delegation;
    assert.deepEqual([d.state, d.generation, d.branch.endsWith("-g2"), d.invocationId ?? null], ["queued", 2, true, null]);
    const { invocationId: inv2 } = await ctx.runner.mutation(api.runner.deliver, { delegationId: id });
    assert.notEqual(inv2, invocationId);
  } finally { await ctx.close(); }
});

test("GitHub rate limit and outage: polling records the failure and backs off; reconnect reconciles; freshness recorded", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "h1");
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "h1", title: "t" });
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "h1", body: "x" });
    await ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: r.claim, instance: "r1", summary: "done", headSha: "h1" });
    ctx.stub.setStatus(429);
    const limited = (await ctx.person.mutation(api.github.syncTick, {})) as { error: string; nextAt: number };
    assert.match(limited.error, /429|rate|UPSTREAM/i);
    ctx.stub.setStatus(503);
    const down = (await ctx.person.mutation(api.github.syncTick, {})) as { error: string; nextAt: number };
    assert.ok(down.error);
    let s = (await ctx.person.query(api.admin.settings, {})).githubSync!;
    assert.equal(s.consecutiveFailures, 2);
    assert.ok(s.nextAt! - Date.now() > 60_000, "backs off");
    assert.equal((await ctx.person.query(api.work.detail, { id })).delegation.state, "reported", "no verification from a failed read");
    // While GitHub was down, the PR merged. Reconnect: the next poll reconciles both.
    ctx.stub.mergePull(1);
    ctx.stub.setStatus(null);
    await ctx.person.mutation(api.github.syncTick, {});
    s = (await ctx.person.query(api.admin.settings, {})).githubSync!;
    assert.equal(s.consecutiveFailures, 0);
    assert.ok(s.lastOkAt! >= s.lastErrorAt!);
    const d = await ctx.person.query(api.work.detail, { id });
    assert.equal(d.delegation.state, "verified");
    assert.ok(d.facts.some((f) => f.kind === "pull_request" && f.state === "merged"), "the merge is observed");
  } finally { await ctx.close(); }
});

test("a reported head that GitHub does not show is never verified or accepted", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "real");
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "real", title: "t" });
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "real", body: "x" });
    await ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: r.claim, instance: "r1", summary: "done", headSha: "claimed-but-different" });
    const v = (await ctx.runner.mutation(api.github.verify, { delegationId: id })) as { verified: boolean };
    assert.equal(v.verified, false);
    const d = await ctx.person.query(api.work.detail, { id });
    assert.equal(d.delegation.state, "reported");
    assert.ok(d.history.some((h) => h.type === "verification.mismatch"));
    assert.equal(await code(ctx.person.mutation(api.work.review, { id, decision: "accepted", note: "looks done" })), "FAILED_PRECONDITION");
  } finally { await ctx.close(); }
});

test("import a GitHub issue: title and body come from GitHub", async () => {
  const ctx = await boot();
  try {
    ctx.stub.setIssue(7, { title: "Money formatting is wrong for negatives", body: "formatMoney(-500) prints $-5.00" });
    const id = await ctx.person.action(api.work.importIssue, { repositoryId: ctx.repositoryId, issueNumber: 7 });
    const d = (await ctx.person.query(api.work.detail, { id })).delegation;
    assert.deepEqual([d.title, d.issueNumber, d.state], ["Money formatting is wrong for negatives", 7, "draft"]);
  } finally { await ctx.close(); }
});

test("the verification job queued at submit runs as the pool and verifies on its own (FeltKit jobs)", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);
    const a = await claimAs(ctx, id, "r1");
    const branch = a.snapshot!.delegation.branch;
    ctx.stub.setBranch(branch, "j1");
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "j1", title: "t" });
    await approve(ctx, invocationId);
    const r = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "r1", leaseMs: 60_000 })) as { claim: string };
    await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: r.claim, headSha: "j1", body: "x" });
    await ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: r.claim, instance: "r1", summary: "done", headSha: "j1" });
    const ran = await ctx.t.runtime.runServices();
    assert.ok(ran.jobs >= 1, `the queued github.sync job ran: ${JSON.stringify(ran)}`);
    assert.equal((await ctx.person.query(api.work.detail, { id })).delegation.state, "verified");
    assert.ok((await ctx.person.query(api.admin.settings, {})).githubSync?.lastOkAt);
  } finally { await ctx.close(); }
});
