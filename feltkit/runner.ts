/**
 * The runner pool's capabilities (role `runner`, over MCP or AppPort).
 *
 * Execution control is FeltKit's invocation lifecycle: deliver (bridge accept) → start (claim + lease)
 * → progress (heartbeat; a stale claim is refused) → awaiting_approval → resume (refused until the
 * person approved) → completed / failed. A runner's statements are recorded as `source: runner`; they
 * never move a delegation to verified or accepted.
 *
 * Runner identity is shared by the whole trusted pool (Phase 0 S2). `instance` is the runner's own,
 * unauthenticated label: recorded as asserted evidence, never used for authorization.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx, QueryCtx } from "@feltdb/feltkit";
import { EVENT_KINDS, USAGE, agents, app, delegations, facts, runEvents, workers } from "./app.js";
import { RUNTIME_CAPABILITIES, invocationKey, load, note, now, policyOf, redact, repoOf, transition } from "./_lib.js";

const leaseWithin = (ms: number, p: { leaseMinMs: number; leaseMaxMs: number }) => Math.min(p.leaseMaxMs, Math.max(p.leaseMinMs, Math.round(ms)));
/** Every known control gets a value; anything undeclared or unrecognized is "none" (unsupported), never trusted. */
const capabilitiesOf = (declared: Record<string, string>) => Object.fromEntries(Object.entries(RUNTIME_CAPABILITIES as Record<string, readonly string[]>).map(([k, allowed]) => [k, allowed.includes(declared[k] ?? "") ? declared[k]! : "none"]));

function requireRunner(ctx: QueryCtx | MutationCtx) {
  const p = ctx.auth.requirePrincipal();
  if (p.type === "user") fail("FORBIDDEN", "Runner capabilities are for the runner pool, not people.");
  return p;
}

/** Dispatch job for the bridge surface. It starts nothing: a runner claims the work. */
export const placed = app.mutation({ access: "handoff.placed", args: { invocation: s.string() }, handler: async () => null });

/** Work the pool can pick up: queued (to deliver), or delivered and not finished (to claim or re-claim). */
export const next = app.query({
  access: "runner.work",
  returns: s.array(s.object({ id: s.string(), number: s.number(), state: s.string(), invocationId: s.optional(s.string()), leaseExpired: s.boolean() })),
  capability: { name: "runner.next", description: "Delegations the runner pool may deliver, claim or re-claim, oldest first." },
  handler: async (ctx) => {
    requireRunner(ctx);
    const out: Array<{ id: string; number: number; state: string; invocationId?: string; leaseExpired: boolean }> = [];
    const open = (await ctx.db.find(delegations, {})).filter((d) => ["queued", "dispatched", "running", "awaiting_approval"].includes(d.state)).sort((a, b) => a.number - b.number);
    for (const d of open) {
      if (d.state === "queued") { out.push({ id: d.id, number: d.number, state: d.state, leaseExpired: false }); continue; }
      if (!d.invocationId) continue;
      const inv = await ctx.invocations.get(d.invocationId).catch(() => null);
      if (!inv) continue;
      const expired = inv.state === "running" && inv.execution.claimedAt !== null && inv.execution.claimedAt + inv.execution.leaseMs < now();
      if (inv.state === "accepted" || expired || inv.state === "awaiting_approval") out.push({ id: d.id, number: d.number, state: d.state, invocationId: d.invocationId, leaseExpired: expired });
    }
    return out;
  },
});

/** Deliver a queued delegation into FeltKit's invocation lifecycle, for the person who delegated it. Idempotent. */
export const deliver = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string() },
  returns: s.object({ invocationId: s.string(), replayed: s.boolean() }),
  capability: { name: "runner.deliver", description: "Deliver a queued delegation for execution (idempotent)." },
  handler: async (ctx, { delegationId }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    if (d.state !== "queued") {
      if (d.invocationId && ["dispatched", "running", "awaiting_approval"].includes(d.state)) return { invocationId: d.invocationId, replayed: true };
      fail("FAILED_PRECONDITION", `Delegation is ${d.state}; only queued work is delivered.`);
    }
    const envelope = { contract: "feltkit.invocation/1", invocationId: invocationKey(d), surface: { id: "delegation", version: "1.0.0" }, instruction: d.title, context: [], returnTo: { kind: "app" }, submittedAt: now() };
    const receipt = await ctx.invocations.accept({ surface: "delegation", person: d.requestedBy, envelope, dispatch: { job: "handoff.placed" } });
    await transition(ctx, d, "dispatched", "runner", "delegation.dispatched", { invocationId: receipt.id, generation: d.generation }, { invocationId: receipt.id });
    return { invocationId: receipt.id, replayed: Boolean(receipt.replayed) };
  },
});

/** Claim execution: a new FeltKit attempt with a lease. A live claim elsewhere answers proceed: false. */
export const claim = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), instance: s.string({ minLength: 1, maxLength: 80 }), leaseMs: s.number() },
  returns: s.unknown(),
  capability: { name: "runner.claim", description: "Claim the delegation's next execution attempt (lease)." },
  handler: async (ctx, { delegationId, instance, leaseMs }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    if (!d.invocationId) fail("FAILED_PRECONDITION", "Deliver the delegation first.");
    if (!["dispatched", "running"].includes(d.state)) fail("FAILED_PRECONDITION", `Delegation is ${d.state}.`);
    const pol = await policyOf(ctx);
    const started = await ctx.invocations.start(d.invocationId, { worker: instance, leaseMs: leaseWithin(leaseMs, pol) });
    if (!started.proceed) return { proceed: false, reason: started.reason ?? started.state };
    if ((started.attempt ?? 1) > pol.maxAttempts) {
      // Policy, enforced at the claim boundary: this generation has used its attempts.
      await ctx.invocations.transition(d.invocationId, "failed", { claim: started.claim!, error: { code: "ATTEMPTS_EXHAUSTED", message: `Attempt ${started.attempt} exceeds the policy's ${pol.maxAttempts}.` } });
      await transition(ctx, d, "failed", "system", "attempts.exhausted", { attempt: started.attemptId, attemptNumber: started.attempt, maxAttempts: pol.maxAttempts, previous: started.previous ?? [] }, { failure: { code: "ATTEMPTS_EXHAUSTED", message: `Stopped after ${pol.maxAttempts} attempts.`, at: now() } });
      return { proceed: false, reason: "ATTEMPTS_EXHAUSTED" };
    }
    const uncertain = started.previous?.some((p) => p.outcome === "unknown") ?? false;
    await transition(ctx, d, "running", "runner", uncertain ? "attempt.takeover" : "attempt.started", {
      attempt: started.attemptId, attemptNumber: started.attempt, instance, instanceAuthenticated: false, previous: started.previous ?? [],
      ...(ctx.auth.session?.ref ? { sessionRef: ctx.auth.session.ref } : {}),
    });
    return { proceed: true, claim: started.claim, attemptId: started.attemptId, attemptNumber: started.attempt, previous: started.previous ?? [], snapshot: await snapshotOf(ctx, delegationId) };
  },
});

async function snapshotOf(ctx: QueryCtx | MutationCtx, delegationId: string) {
  const d = await load(ctx, delegationId);
  const repo = await repoOf(ctx, d.repositoryId);
  const [agent] = d.agentKey ? await ctx.db.find(agents, { key: d.agentKey }) : [];
  const prFacts = (await ctx.db.find(facts, { delegationId })).filter((f) => f.kind === "pull_request" || f.kind === "unknown_write").sort((a, b) => a.observedAt - b.observedAt);
  const inv = d.invocationId ? await ctx.invocations.get(d.invocationId).catch(() => null) : null;
  return {
    delegation: { id: d.id, number: d.number, title: d.title, objective: d.objective, criteria: d.criteria, baseBranch: d.baseBranch, branch: d.branch, generation: d.generation, state: d.state, agentTaskId: d.agentTaskId ?? null },
    repository: { owner: repo.owner, name: repo.name },
    agent: agent ? { key: agent.key, definition: agent.definition, model: agent.model } : null,
    prFacts,
    invocation: inv ? { state: inv.state, attempts: inv.execution.attempts, approval: inv.approval ?? null } : null,
  };
}

export const snapshot = app.query({
  access: "runner.work",
  args: { delegationId: s.string() },
  returns: s.unknown(),
  capability: { name: "runner.snapshot", description: "What the runner needs to work or recover a delegation." },
  handler: async (ctx, { delegationId }) => { requireRunner(ctx); return snapshotOf(ctx, delegationId); },
});

/** Heartbeat + observations. Renews the lease; refused for a stale or cancelled claim. Duplicate events are ignored. */
export const report = app.mutation({
  access: "runner.work",
  args: {
    delegationId: s.string(), claim: s.string(), instance: s.string(),
    events: s.array(s.object({ seq: s.number(), kind: s.enum(EVENT_KINDS), text: s.string(), at: s.number(), session: s.optional(s.string()), turn: s.optional(s.string()), status: s.optional(s.string()), callId: s.optional(s.string()), usage: s.optional(USAGE) })),
    runtime: s.optional(s.object({ session: s.optional(s.string()), turn: s.optional(s.string()), mode: s.optional(s.string()), capabilities: s.record(s.string()) })),
  },
  returns: s.object({ leaseUntil: s.number(), accepted: s.number(), duplicates: s.number() }),
  capability: { name: "runner.report", description: "Report progress and observations; renews the lease." },
  handler: async (ctx, { delegationId, claim, instance, events, runtime }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    if (!d.invocationId) fail("FAILED_PRECONDITION", "Not delivered.");
    const { leaseUntil } = await ctx.invocations.progress(d.invocationId, { claim, note: `${events.length} event(s) from ${instance}` });
    const inv = await ctx.invocations.get(d.invocationId);
    const attempt = inv.execution.attempt ?? "unknown";
    let accepted = 0; let duplicates = 0;
    for (const e of events) {
      const [seen] = await ctx.db.find(runEvents, { attempt, seq: e.seq });
      if (seen) { duplicates++; continue; }
      await ctx.db.insert(runEvents, { delegationId, attempt, instance, seq: e.seq, kind: e.kind, text: redact(e.text).slice(0, 4000), at: e.at, receivedAt: now(), ...(e.session ? { session: e.session } : {}), ...(e.turn ? { turn: e.turn } : {}), ...(e.status ? { status: e.status } : {}), ...(e.callId ? { callId: e.callId } : {}), ...(e.usage ? { usage: e.usage } : {}) });
      accepted++;
    }
    if (runtime) {
      const prev = d.runtime;
      await ctx.db.patch(delegations, d.id, { runtime: { instance, attempt, ...(runtime.session ? { session: runtime.session } : {}), ...(runtime.turn ? { turn: runtime.turn } : {}), ...(runtime.mode ? { mode: runtime.mode } : {}), capabilities: capabilitiesOf(runtime.capabilities), at: now() } });
      if (runtime.session && prev?.session !== runtime.session) await note(ctx, d.id, "runner", "session.started", { session: runtime.session, attempt, instance, instanceAuthenticated: false, capabilities: capabilitiesOf(runtime.capabilities) });
    }
    return { leaseUntil, accepted, duplicates };
  },
});

/** Link the FeltKit agent task the runner opened, so people can steer it (agent control). */
export const bindTask = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), claim: s.string(), agentTaskId: s.string() },
  capability: { name: "runner.bindtask", description: "Link the agent task used for steering." },
  returns: s.boolean(),
  handler: async (ctx, { delegationId, claim, agentTaskId }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    await ctx.invocations.progress(d.invocationId!, { claim, note: "steering task bound" });
    if (d.agentTaskId === agentTaskId) return true;
    await ctx.db.patch(delegations, d.id, { agentTaskId, updatedAt: now() });
    await note(ctx, d.id, "runner", "steering.task-bound", { agentTaskId, previous: d.agentTaskId ?? null });
    return true;
  },
});

/** Ask the delegating person to approve opening a pull request. Only that person can approve (FeltKit). */
export const requestApproval = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), claim: s.string(), branch: s.string(), headSha: s.string(), title: s.string() },
  returns: s.unknown(),
  capability: { name: "runner.requestapproval", description: "Request the person's approval to open a pull request." },
  handler: async (ctx, { delegationId, claim, branch, headSha, title }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    if (branch !== d.branch) fail("INVALID_ARGUMENT", `The delegation's branch is ${d.branch}.`);
    const view = await ctx.invocations.transition(d.invocationId!, "awaiting_approval", { claim, approval: { action: "github.pr.open", input: { branch, headSha, title } } });
    await transition(ctx, d, "awaiting_approval", "runner", "approval.requested", { action: "github.pr.open", branch, headSha, digest: view.approval?.digest });
    ctx.afterCommit.notifications.send({ recipient: d.requestedBy, type: "approval.requested", title: `Approve a pull request for #${d.number}`, body: `${branch} at ${headSha.slice(0, 12)}`, data: { delegationId } });
    return { digest: view.approval?.digest ?? null };
  },
});

/** After the person approved: a new attempt and claim. FeltKit refuses (NOT_APPROVED) until then. */
export const resume = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), instance: s.string(), leaseMs: s.number() },
  returns: s.unknown(),
  capability: { name: "runner.resume", description: "Resume after approval (refused until the person approved)." },
  handler: async (ctx, { delegationId, instance, leaseMs }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    const r = await ctx.invocations.resume(d.invocationId!, { worker: instance, leaseMs: leaseWithin(leaseMs, await policyOf(ctx)) });
    if (!r.proceed) return { proceed: false, reason: r.reason ?? r.state };
    const inv = await ctx.invocations.get(d.invocationId!);
    await transition(ctx, d, "running", "runner", "approval.resumed", { attempt: r.attemptId, instance, instanceAuthenticated: false, approvedBy: inv.approval?.decision?.approvedBy ?? null });
    return { proceed: true, claim: r.claim, attemptId: r.attemptId };
  },
});

/** The runner's claim that the work is done. Recorded as a report; verification comes from GitHub. */
export const submit = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), claim: s.string(), instance: s.string(), summary: s.string({ maxLength: 4000 }), headSha: s.string() },
  returns: s.boolean(),
  capability: { name: "runner.submit", description: "Report the work done (a claim; GitHub verification follows)." },
  handler: async (ctx, { delegationId, claim, instance, summary: said, headSha }) => {
    const summary = redact(said);
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    await ctx.invocations.transition(d.invocationId!, "completed", { claim, result: { headSha, branch: d.branch } });
    await transition(ctx, d, "reported", "runner", "result.reported", { headSha, instance, instanceAuthenticated: false }, { report: { summary, headSha, at: now(), instance } });
    ctx.afterCommit.jobs.enqueue("github.sync", { reason: `reported #${d.number}` });
    return true;
  },
});

/** The attempt failed. `effect: "possible"` marks an external effect whose outcome is unknown. */
export const failAttempt = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), claim: s.string(), code: s.string(), message: s.string(), effect: s.enum(["none", "possible"]) },
  returns: s.boolean(),
  capability: { name: "runner.fail", description: "Report that the attempt failed." },
  handler: async (ctx, { delegationId, claim, code, message: said, effect }) => {
    const message = redact(said);
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    await ctx.invocations.transition(d.invocationId!, "failed", { claim, error: { code: effect === "possible" ? "OUTCOME_UNKNOWN" : code, message } });
    await transition(ctx, d, "failed", "runner", "attempt.failed", { code, message, effect }, { failure: { code, message, at: now() } });
    return true;
  },
});

/** Whether the runner should keep working: cancelled or finished work stops it. */
export const status = app.query({
  access: "runner.work",
  args: { delegationId: s.string() },
  returns: s.object({ state: s.string(), invocationState: s.optional(s.string()) }),
  capability: { name: "runner.status", description: "The delegation's and invocation's state." },
  handler: async (ctx, { delegationId }) => {
    requireRunner(ctx);
    const d = await load(ctx, delegationId);
    const inv = d.invocationId ? await ctx.invocations.get(d.invocationId).catch(() => null) : null;
    return { state: d.state, ...(inv ? { invocationState: inv.state } : {}) };
  },
});


/** A runner process's heartbeat: what it says it is and is doing. Self-reported; never authority. */
export const heartbeat = app.mutation({
  access: "runner.work",
  args: {
    instance: s.string({ minLength: 1, maxLength: 80 }), state: s.enum(["idle", "working", "stopping"]),
    runtime: s.object({ name: s.string(), version: s.string(), node: s.string(), model: s.optional(s.string()) }),
    capabilities: s.record(s.string()),
    delegationId: s.optional(s.string()), attempt: s.optional(s.string()), session: s.optional(s.string()), lastError: s.optional(s.string({ maxLength: 500 })),
  },
  returns: s.boolean(),
  capability: { name: "runner.heartbeat", description: "Report this runner process's state (self-reported, not identity)." },
  handler: async (ctx, a) => {
    requireRunner(ctx);
    const at = now();
    const [w] = await ctx.db.find(workers, { instance: a.instance });
    const sessionRef = ctx.auth.session?.ref;
    const record = { ...a, ...(a.lastError ? { lastError: redact(a.lastError) } : {}), capabilities: capabilitiesOf(a.capabilities), ...(sessionRef ? { sessionRef } : {}), lastSeenAt: at };
    if (w) await ctx.db.replace(workers, w.id, { ...record, firstSeenAt: w.firstSeenAt });
    else await ctx.db.insert(workers, { ...record, firstSeenAt: at });
    return true;
  },
});

/**
 * FeltKit's auth.onSessionEnd hook, run as the ending session's principal. A runner whose pool session was
 * revoked (or expired) is marked so on Agents; its claims stop at their next fenced call, because FeltKit
 * refuses the revoked token. People's sessions ending changes nothing here.
 */
export const sessionEnded = app.mutation({
  access: "authenticated",
  args: { session: s.string(), reason: s.string() },
  handler: async (ctx, { session, reason }) => {
    if (ctx.auth.requirePrincipal().type === "user") return null;
    for (const w of await ctx.db.find(workers, { sessionRef: session } as never)) await ctx.db.patch(workers, w.id, { sessionEnded: { reason, at: now() } });
    return null;
  },
});
