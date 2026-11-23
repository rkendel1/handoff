/**
 * People's side of a delegation: create (or import), assign, cancel, review, and the read models.
 * Every transition goes through _lib.transition (allowed-from table + audit trail, one transaction).
 */
import { fail, s } from "@feltdb/feltkit";
import { ref } from "@feltdb/feltkit/client";
import { agents, app, delegations, facts, history, repositories, runEvents, sync } from "./app.js";
import { branchFor, load, now, repoOf, requirePerson, transition } from "./_lib.js";

export const create = app.mutation({
  access: "work.create",
  args: {
    title: s.string({ minLength: 3, maxLength: 200 }),
    objective: s.string({ minLength: 3, maxLength: 1800 }),
    criteria: s.array(s.string()),
    repositoryId: s.string(),
    baseBranch: s.optional(s.string()),
    issueNumber: s.optional(s.number()),
  },
  handler: async (ctx, a) => {
    const who = requirePerson(ctx, "delegate work");
    const repo = await repoOf(ctx, a.repositoryId);
    const number = await ctx.db.sequence("delegation-number");
    const at = now();
    const d = { number, generation: 1 };
    const id = await ctx.db.insert(delegations, {
      ...a, baseBranch: a.baseBranch ?? repo.defaultBranch, requestedBy: who.id, state: "draft", generation: 1,
      branch: branchFor(d), number, createdAt: at, updatedAt: at,
    });
    await history.record(ctx, { subject: "delegation", id, type: "delegation.created", data: { source: "person", title: a.title, repository: `${repo.owner}/${repo.name}`, issueNumber: a.issueNumber ?? null } });
    return id;
  },
});

/** Import a GitHub issue as a delegation. The issue's title and body come from GitHub, read by Handoff. */
export const importIssue = app.action({
  access: "work.create",
  args: { repositoryId: s.string(), issueNumber: s.number() },
  handler: async (ctx, { repositoryId, issueNumber }): Promise<string> => {
    const repo = await ctx.runQuery(api_repo, { id: repositoryId });
    const issue = (await ctx.integrations.invoke("github.issueget", { owner: repo.owner, repo: repo.name, number: issueNumber })) as { title: string; body: unknown; state: string };
    const body = typeof issue.body === "string" && issue.body.trim() ? issue.body.trim().slice(0, 1800) : issue.title;
    return ctx.runMutation(api_create, { title: issue.title.slice(0, 200).padEnd(3, "."), objective: body.padEnd(3, "."), criteria: [], repositoryId, issueNumber });
  },
});

export const repository = app.query({
  access: "repos.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => repoOf(ctx, id),
});

/** Assign an agent: the delegation is queued for the runner pool in this same transaction. */
export const assign = app.mutation({
  access: "work.assign",
  args: { id: s.string(), agentKey: s.string() },
  handler: async (ctx, { id, agentKey }) => {
    requirePerson(ctx, "assign work");
    const d = await load(ctx, id);
    const [agent] = await ctx.db.find(agents, { key: agentKey });
    if (!agent) fail("NOT_FOUND", `No agent ${agentKey}.`);
    if (agent.status !== "active") fail("FAILED_PRECONDITION", `${agent.name} is ${agent.status}.`);
    await transition(ctx, d, "queued", "person", "delegation.assigned", { agentKey }, { agentKey });
  },
});

/**
 * Cancel. Stops further authorized work at the platform: the FeltKit invocation is cancelled (only
 * the person the work is for may do this), so the runner's next report, approval request or result
 * is refused. The runner's agent task is stopped separately by the UI (agent control `stop`).
 */
export const cancel = app.mutation({
  access: "work.cancel",
  args: { id: s.string(), reason: s.string({ minLength: 3 }) },
  handler: async (ctx, { id, reason }) => {
    const who = requirePerson(ctx, "cancel work");
    const d = await load(ctx, id);
    if (d.requestedBy !== who.id) fail("FORBIDDEN", "Only the person who delegated this work can cancel it (FeltKit lets only the person an invocation is for cancel it).");
    if (d.invocationId) {
      const inv = await ctx.invocations.get(d.invocationId);
      if (!["completed", "failed", "cancelled"].includes(inv.state)) await ctx.invocations.cancel(d.invocationId, { reason });
    }
    await transition(ctx, d, "cancelled", "person", "delegation.cancelled", { reason, invocationId: d.invocationId ?? null });
  },
});

/**
 * A person's review. Accept only verified work (GitHub shows a PR whose head is the reported commit);
 * return it for more work (a new generation and branch); or reject it.
 */
export const review = app.mutation({
  access: "work.review",
  args: { id: s.string(), decision: s.enum(["accepted", "returned", "rejected"]), note: s.string({ minLength: 3 }) },
  handler: async (ctx, { id, decision, note }) => {
    const who = requirePerson(ctx, "review work");
    const d = await load(ctx, id);
    const at = now();
    const review = { decision, by: who.id, at, note };
    if (decision === "accepted") {
      if (d.state !== "verified" || !d.verified || !d.report || d.verified.headSha !== d.report.headSha)
        fail("FAILED_PRECONDITION", "Only verified work can be accepted: GitHub must show a pull request whose head is the commit the runner reported.");
      return transition(ctx, d, "accepted", "person", "review.accepted", { note, prNumber: d.verified.prNumber, headSha: d.verified.headSha }, { review });
    }
    if (decision === "rejected") return transition(ctx, d, "rejected", "person", "review.rejected", { note }, { review });
    if (!["reported", "verified", "failed"].includes(d.state)) fail("FAILED_PRECONDITION", `A ${d.state} delegation cannot be returned.`);
    const next = { number: d.number, generation: d.generation + 1 };
    return transition(ctx, d, "queued", "person", "review.returned", { note, generation: next.generation }, {
      review, generation: next.generation, branch: branchFor(next), invocationId: undefined, agentTaskId: undefined, report: undefined, verified: undefined, failure: undefined,
      objective: `${d.objective}\n\nReturned by ${who.id}: ${note}`.slice(0, 1800),
    });
  },
});

// ───────────────────────── Read models ─────────────────────────

export const list = app.query({
  access: "work.read",
  args: { state: s.optional(s.string()) },
  handler: async (ctx, { state }) => {
    const all = await ctx.db.find(delegations, state ? { state: state as never } : {});
    return all.sort((a, b) => b.number - a.number);
  },
});

export const detail = app.query({
  access: "work.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const d = await load(ctx, id);
    const repo = await ctx.db.get(repositories, d.repositoryId);
    const [events, observed, trail] = await Promise.all([
      ctx.db.find(runEvents, { delegationId: id }),
      ctx.db.find(facts, { delegationId: id }),
      history.history(ctx, "delegation", id),
    ]);
    // The FeltKit invocation (attempts, lease, approval) is visible to the person it is for.
    let invocation: unknown = null;
    const p = ctx.auth.principal;
    if (d.invocationId && p?.id === d.requestedBy) invocation = await ctx.invocations.get(d.invocationId).catch(() => null);
    return {
      delegation: d, repository: repo,
      events: events.sort((a, b) => (a.attempt === b.attempt ? a.seq - b.seq : a.receivedAt - b.receivedAt)),
      facts: observed.sort((a, b) => a.observedAt - b.observedAt),
      history: trail, invocation,
    };
  },
});

/**
 * The timeline of one delegation, keeping its layers distinct:
 *   generation (one FeltKit invocation) → attempt (one claim) → session (EVE runtime) → turn → activity,
 * beside decisions (people), evidence (runner claims) and external facts (GitHub reads).
 * Every entry says where it came from and how much it can be trusted:
 *   reported (a runner said so) · observed (Handoff read it from GitHub) · verified (a GitHub fact matched a claim) · decided (a person).
 */
export const timeline = app.query({
  access: "work.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const d = await load(ctx, id);
    const [events, observed, trail] = await Promise.all([ctx.db.find(runEvents, { delegationId: id }), ctx.db.find(facts, { delegationId: id }), history.history(ctx, "delegation", id)]);
    type Entry = { at: number; layer: string; source: string; trust: "reported" | "observed" | "verified" | "decided" | "system"; title: string; detail?: unknown; generation?: number; attempt?: string; session?: string; turn?: string; ref?: string };
    const entries: Entry[] = [];
    const LAYER: Record<string, string> = {
      "delegation.created": "delegation", "delegation.assigned": "delegation", "delegation.dispatched": "generation", "review.returned": "decision", "review.accepted": "decision", "review.rejected": "decision", "delegation.cancelled": "decision",
      "attempt.started": "attempt", "attempt.takeover": "attempt", "attempt.failed": "attempt", "attempts.exhausted": "attempt", "approval.resumed": "decision", "approval.requested": "approval",
      "session.started": "session", "steering.task-bound": "control", "result.reported": "evidence", "result.verified": "fact", "verification.mismatch": "fact",
      "github.write.unknown": "fact", "github.pr.created": "fact", "github.pr.reconciled": "fact",
    };
    let generation = 1;
    for (const h of trail) {
      const data = (h.data ?? {}) as Record<string, unknown>;
      if (h.type === "delegation.dispatched" && typeof data.generation === "number") generation = data.generation;
      if (h.type === "review.returned" && typeof data.generation === "number") generation = data.generation;
      const source = String(data.source ?? "system");
      const layer = LAYER[h.type] ?? (h.type.startsWith("github.") ? "fact" : "delegation");
      const trust = source === "person" ? "decided" : source === "github" ? (h.type === "result.verified" ? "verified" : "observed") : source === "runner" ? "reported" : "system";
      entries.push({ at: h.at, layer, source, trust, title: h.type, detail: data, generation, ...(typeof data.attempt === "string" ? { attempt: data.attempt } : {}), ...(typeof data.session === "string" ? { session: data.session } : {}), ref: `history:${h.seq}` });
    }
    for (const e of events) entries.push({ at: e.at, layer: "activity", source: "runner", trust: "reported", title: e.kind, detail: { text: e.text, status: e.status ?? null, instance: e.instance, seq: e.seq }, attempt: e.attempt, ...(e.session ? { session: e.session } : {}), ...(e.turn ? { turn: e.turn } : {}), ref: `event:${e.attempt}:${e.seq}` });
    for (const f of observed) if (!["unknown_write"].includes(f.kind)) entries.push({ at: f.observedAt, layer: "fact", source: "github", trust: "observed", title: `github.${f.kind}`, detail: { prNumber: f.prNumber ?? null, headSha: f.headSha ?? null, state: f.state ?? null, url: f.url ?? null, via: f.via }, ref: `fact:${f.id}` });
    entries.sort((a, b) => a.at - b.at);
    // The hierarchy: attempts in order, each with its sessions and turns (from the runner's reports).
    const attempts = trail.filter((h) => h.type === "attempt.started" || h.type === "attempt.takeover" || h.type === "approval.resumed").map((h) => {
      const data = h.data as Record<string, unknown>;
      const attempt = String(data.attempt);
      const mine = events.filter((e) => e.attempt === attempt);
      const sessions = [...new Set(mine.map((e) => e.session ?? "(no session reported)"))].map((session) => {
        const inSession = mine.filter((e) => (e.session ?? "(no session reported)") === session);
        const turns = [...new Set(inSession.map((e) => e.turn ?? "(no turn reported)"))].map((turn) => ({ turn, events: inSession.filter((e) => (e.turn ?? "(no turn reported)") === turn).length }));
        return { session, turns, events: inSession.length };
      });
      return { attempt, how: h.type, instance: String(data.instance ?? ""), instanceAuthenticated: false, at: h.at, previous: data.previous ?? [], sessions, events: mine.length };
    });
    return { delegation: { id: d.id, number: d.number, state: d.state, generation: d.generation, branch: d.branch }, attempts, entries };
  },
});

/** The Desk: what needs the signed-in person's attention, and why. Derived from durable records, never stored. */
export const desk = app.query({
  access: "work.read",
  handler: async (ctx) => {
    const me = ctx.auth.requirePrincipal().id;
    const at = now();
    const all = await ctx.db.find(delegations, {});
    const allFacts = await ctx.db.find(facts, {});
    const row = (d: (typeof all)[number], reason: string) => ({ id: d.id, number: d.number, title: d.title, state: d.state, agentKey: d.agentKey ?? null, requestedBy: d.requestedBy, mine: d.requestedBy === me, updatedAt: d.updatedAt, reason });
    const unresolvedUnknown = (id: string) => {
      const f = allFacts.filter((x) => x.delegationId === id).sort((a, b) => b.observedAt - a.observedAt);
      const lastUnknown = f.find((x) => x.kind === "unknown_write");
      const lastPr = f.find((x) => x.kind === "pull_request");
      return lastUnknown && (!lastPr || lastPr.observedAt < lastUnknown.observedAt);
    };
    const STALE_MS = 2 * 60_000;
    const groups = {
      awaitingAssignment: all.filter((d) => d.state === "draft").map((d) => row(d, "Assign an agent to start")),
      awaitingApproval: all.filter((d) => d.state === "awaiting_approval").map((d) => row(d, d.requestedBy === me ? "The runner asks you to approve opening a pull request" : `Waiting for ${d.requestedBy} to approve a pull request`)),
      waitingForInput: all.filter((d) => ["running", "dispatched"].includes(d.state) && ["paused", "interrupted"].includes(d.runtime?.mode ?? "")).map((d) => row(d, `The agent is ${d.runtime!.mode}: resume or send an update`)),
      failedOrUncertain: all.filter((d) => d.state === "failed" || (d.state === "running" && (unresolvedUnknown(d.id) || (d.runtime && at - d.runtime.at > STALE_MS)))).map((d) =>
        row(d, d.state === "failed" ? `Failed: ${d.failure?.message ?? "see history"}` : unresolvedUnknown(d.id) ? "An external write's outcome is unknown: GitHub does not show it yet" : `No runner report for ${Math.round((at - d.runtime!.at) / 60000)} min: the lease may expire and another runner take over`)),
      needsReview: all.filter((d) => d.state === "verified" || d.state === "reported").map((d) => row(d, d.state === "verified" ? "Verified on GitHub: review and accept" : "Reported done: waiting for GitHub to confirm")),
      active: all.filter((d) => ["queued", "dispatched", "running"].includes(d.state)).map((d) => row(d, d.state === "queued" ? "Waiting for a runner" : d.runtime ? `Runner ${d.runtime.instance} (asserted) · reported ${Math.round((at - d.runtime.at) / 1000)} s ago` : "Running")),
      recentlyAccepted: all.filter((d) => d.state === "accepted").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map((d) => row(d, `Accepted by ${d.review?.by ?? "?"}`)),
    };
    const [githubSync] = await ctx.db.find(sync, { key: "github" });
    return { ...groups, githubSync: githubSync ?? null };
  },
});

const api_repo = ref<"query", { id: string }, { owner: string; name: string; defaultBranch: string }>("work:repository");
const api_create = ref<"mutation", Record<string, unknown>, string>("work:create");
