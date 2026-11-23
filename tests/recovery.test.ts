/**
 * The mandatory recovery scenario (combined S2/S4): runner A creates a pull request, loses the
 * connection before it can report, crashes; the lease expires; runner B (same trusted pool identity,
 * another instance) takes over, finds and verifies A's pull request through GitHub, does not create a
 * duplicate, reports; GitHub verification follows; a person accepts. Every step stays in history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ada, api, approve, boot, claimAs, delegated, sleep } from "./support/setup.js";

test("crash after PR creation: takeover reconciles the existing PR, no duplicate, history intact, person accepts", async () => {
  const ctx = await boot();
  try {
    const { id, invocationId } = await delegated(ctx);

    // 1-2. Runner A claims (short lease) and works.
    const a = await claimAs(ctx, id, "runner-A", 2_000);
    assert.equal(a.proceed, true);
    const branch = a.snapshot!.delegation.branch;
    await ctx.runner.mutation(api.runner.report, { delegationId: id, claim: a.claim!, instance: "runner-A", events: [{ seq: 1, kind: "progress", text: "editing src/money.js", at: Date.now() }] });
    ctx.stub.setBranch(branch, "sha-A-1"); // A pushed its work

    // Approval for exactly this branch and head; the delegator decides.
    await ctx.runner.mutation(api.runner.requestApproval, { delegationId: id, claim: a.claim!, branch, headSha: "sha-A-1", title: "Fix negative money" });
    await approve(ctx, invocationId);
    const resumed = (await ctx.runner.mutation(api.runner.resume, { delegationId: id, instance: "runner-A", leaseMs: 2_000 })) as { proceed: boolean; claim: string };
    assert.equal(resumed.proceed, true);

    // 3-4. A opens the PR; GitHub creates it, then the connection drops before any answer.
    ctx.stub.dropNextCreate();
    const opened = (await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: resumed.claim, headSha: "sha-A-1", body: "Fixes negative amounts." })) as { created: unknown; verifiedAfterUnknown?: boolean; outcome?: string };
    assert.equal(ctx.stub.counts.pullsCreated, 1, "GitHub has the PR");
    // FeltKit recorded the write as unknown; Handoff verified by reading GitHub, never by assuming.
    const afterUnknown = await ctx.person.query(api.work.detail, { id });
    assert.ok(afterUnknown.facts.some((f) => f.kind === "unknown_write"), "the unknown outcome is recorded");
    assert.ok(opened.verifiedAfterUnknown === true || opened.outcome === "unknown");
    // 4-5. A crashes here: no submit. The work is not marked successful.
    assert.equal(afterUnknown.delegation.state, "running");
    assert.equal(afterUnknown.delegation.report, undefined);

    // A live lease blocks a takeover.
    const early = await claimAs(ctx, id, "runner-B", 2_000);
    assert.equal(early.proceed, false, "no takeover while A's lease holds");

    // 6. Lease expires.
    await sleep(2_300);
    const listed = await ctx.runner.query(api.runner.next, {});
    assert.ok(listed.some((x) => x.id === id && x.leaseExpired), "the pool sees the stalled attempt");

    // 7. Runner B takes over as the next attempt; A's attempt is unknown.
    const b = await claimAs(ctx, id, "runner-B", 60_000);
    assert.equal(b.proceed, true);
    assert.ok(b.previous!.some((p) => p.outcome === "unknown"), "previous attempt reads unknown");

    // A stale report from A is refused and changes nothing.
    await assert.rejects(ctx.runner.mutation(api.runner.report, { delegationId: id, claim: resumed.claim, instance: "runner-A", events: [{ seq: 2, kind: "progress", text: "late", at: Date.now() }] }), /claim/i);

    // 8-10. B inspects GitHub, finds A's PR, does not create another.
    const createRequestsBefore = ctx.stub.counts.createRequests;
    const reconciled = (await ctx.runner.mutation(api.github.openPullRequest, { delegationId: id, claim: b.claim!, headSha: "sha-A-1", body: "Fixes negative amounts." })) as { created: boolean; reconciled: boolean; prNumber: number };
    assert.deepEqual([reconciled.created, reconciled.reconciled, reconciled.prNumber], [false, true, 1]);
    assert.equal(ctx.stub.counts.createRequests, createRequestsBefore, "no second create request reached GitHub");
    assert.equal(ctx.stub.pulls.length, 1, "exactly one pull request exists");

    // B reports; GitHub verification is separate from the report.
    await ctx.runner.mutation(api.runner.submit, { delegationId: id, claim: b.claim!, instance: "runner-B", summary: "Recovered A's work; PR #1 verified.", headSha: "sha-A-1" });
    assert.equal((await ctx.person.query(api.work.detail, { id })).delegation.state, "reported");
    await assert.rejects(ctx.person.mutation(api.work.review, { id, decision: "accepted", note: "too early" }), { code: "FAILED_PRECONDITION" });
    await ctx.person.mutation(api.github.syncTick, {});
    const verified = await ctx.person.query(api.work.detail, { id });
    assert.equal(verified.delegation.state, "verified");
    assert.deepEqual([verified.delegation.verified!.prNumber, verified.delegation.verified!.headSha], [1, "sha-A-1"]);

    // 12. A person accepts.
    await ctx.person.mutation(api.work.review, { id, decision: "accepted", note: "Diff reviewed on GitHub." });
    const done = await ctx.person.query(api.work.detail, { id });
    assert.equal(done.delegation.state, "accepted");

    // 11. The history records the uncertain interval, takeover, verification and outcome, in order.
    const types = done.history.map((h) => h.type);
    for (const step of ["delegation.created", "delegation.assigned", "delegation.dispatched", "attempt.started", "approval.requested", "approval.resumed", "github.pr.observed", "github.write.unknown", "attempt.takeover", "github.pr.reconciled", "result.reported", "result.verified", "review.accepted"])
      assert.ok(types.includes(step), `history has ${step}: ${types.join(", ")}`);
    assert.ok(types.indexOf("github.write.unknown") < types.indexOf("attempt.takeover") && types.indexOf("attempt.takeover") < types.indexOf("github.pr.reconciled"));
    const takeover = done.history.find((h) => h.type === "attempt.takeover")!;
    assert.equal((takeover.data as { instance: string }).instance, "runner-B");
    assert.equal((takeover.data as { instanceAuthenticated: boolean }).instanceAuthenticated, false, "instance ids are recorded as asserted only");
    // The FeltKit invocation shows both attempts for the person.
    const inv = await ctx.t.runtime.invocations.get(ada, invocationId);
    assert.ok(inv.executions[0]!.attempts.length >= 3);
    assert.equal(inv.approval?.decision?.approvedBy, "ada");
  } finally {
    await ctx.close();
  }
});
