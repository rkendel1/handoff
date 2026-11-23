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

/** The Desk: what needs the signed-in person, and what is moving. Derived, never stored. */
export const desk = app.query({
  access: "work.read",
  handler: async (ctx) => {
    const me = ctx.auth.requirePrincipal().id;
    const all = await ctx.db.find(delegations, {});
    const mine = all.filter((d) => d.requestedBy === me);
    const needs = mine.flatMap((d) => {
      if (d.state === "awaiting_approval") return [{ id: d.id, number: d.number, title: d.title, reason: "Approve opening a pull request" }];
      if (d.state === "verified") return [{ id: d.id, number: d.number, title: d.title, reason: "Review verified work" }];
      if (d.state === "reported") return [{ id: d.id, number: d.number, title: d.title, reason: "Reported done: waiting for GitHub verification" }];
      if (d.state === "failed") return [{ id: d.id, number: d.number, title: d.title, reason: `Failed: ${d.failure?.message ?? "see history"}` }];
      if (d.state === "draft") return [{ id: d.id, number: d.number, title: d.title, reason: "Assign an agent" }];
      return [];
    });
    const moving = all.filter((d) => ["queued", "dispatched", "running"].includes(d.state)).map((d) => ({ id: d.id, number: d.number, title: d.title, state: d.state, agentKey: d.agentKey ?? null, updatedAt: d.updatedAt }));
    const done = all.filter((d) => ["accepted", "rejected", "cancelled"].includes(d.state)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    const [githubSync] = await ctx.db.find(sync, { key: "github" });
    return { needs, moving, done, githubSync: githubSync ?? null };
  },
});

const api_repo = ref<"query", { id: string }, { owner: string; name: string; defaultBranch: string }>("work:repository");
const api_create = ref<"mutation", Record<string, unknown>, string>("work:create");
