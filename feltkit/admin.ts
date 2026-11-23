/** Workspace administration: agents and repositories. */
import { fail, s } from "@feltdb/feltkit";
import { agents, app, history, policy, repositories, sync, workers } from "./app.js";
import { DEFAULT_POLICY, RUNTIME_CAPABILITIES, now, policyOf, requirePerson } from "./_lib.js";

export const registerAgent = app.mutation({
  access: "agents.manage",
  args: { key: s.string({ minLength: 2, maxLength: 40 }), name: s.string({ minLength: 2 }), definition: s.string({ minLength: 3 }), model: s.string({ minLength: 3 }) },
  handler: async (ctx, a) => {
    requirePerson(ctx, "register an agent");
    const [dup] = await ctx.db.find(agents, { key: a.key });
    if (dup) fail("CONFLICT", `Agent ${a.key} exists.`);
    const id = await ctx.db.insert(agents, { ...a, status: "active" });
    await history.record(ctx, { subject: "agent", id, type: "agent.registered", data: { source: "person", ...a } });
    return id;
  },
});

export const setAgentStatus = app.mutation({
  access: "agents.manage",
  args: { key: s.string(), status: s.enum(["active", "suspended"]), reason: s.string({ minLength: 3 }) },
  handler: async (ctx, { key, status, reason }) => {
    requirePerson(ctx, "change an agent's status");
    const [a] = await ctx.db.find(agents, { key });
    if (!a) fail("NOT_FOUND", `No agent ${key}.`);
    await ctx.db.patch(agents, a.id, { status });
    await history.record(ctx, { subject: "agent", id: a.id, type: `agent.${status}`, data: { source: "person", reason } });
  },
});

export const listAgents = app.query({ access: "agents.read", handler: async (ctx) => ctx.db.find(agents, {}) });

export const addRepository = app.mutation({
  access: "repos.manage",
  args: { owner: s.string({ minLength: 1 }), name: s.string({ minLength: 1 }), defaultBranch: s.string({ minLength: 1 }) },
  handler: async (ctx, a) => {
    requirePerson(ctx, "connect a repository");
    const [dup] = await ctx.db.find(repositories, { owner: a.owner, name: a.name });
    if (dup) return dup.id;
    const id = await ctx.db.insert(repositories, a);
    await history.record(ctx, { subject: "repository", id, type: "repository.connected", data: { source: "person", ...a } });
    return id;
  },
});

export const listRepositories = app.query({ access: "repos.read", handler: async (ctx) => ctx.db.find(repositories, {}) });

export const settings = app.query({
  access: "repos.read",
  handler: async (ctx) => {
    const all = await ctx.db.find(sync, {});
    return {
      githubSync: all.find((x) => x.key === "github") ?? null,
      connections: all.filter((x) => x.key.startsWith("repository:")).map((x) => ({ repositoryId: x.key.slice("repository:".length), lastOkAt: x.lastOkAt ?? null, lastErrorAt: x.lastErrorAt ?? null, lastError: x.lastError ?? null })),
      policy: await policyOf(ctx),
      policyDefaults: DEFAULT_POLICY,
      approvalRules: [{ action: "github.pr.open", rule: "required", approver: "the person who delegated the work", enforcedAt: "runner.openPullRequest (Handoff) and FeltKit invocation approval" }],
      credentials: [
        { ref: "credential-ref:github", holder: "Handoff (FeltKit credential custody)", use: "GitHub reads and pull request creation" },
        { ref: "runner environment", holder: "each runner host", use: "model key and git push credentials; never sent to Handoff" },
      ],
      runtimeCapabilities: RUNTIME_CAPABILITIES,
      runnerIdentity: "One shared runner principal (runner-pool) for one trusted pool. Runner instance ids are asserted, not authenticated; runners cannot be attributed or revoked individually.",
    };
  },
});

/** Change the execution policy (admin). Takes effect at the next claim or resume. */
export const setPolicy = app.mutation({
  access: "repos.manage",
  args: { maxAttempts: s.number(), leaseMinMs: s.number(), leaseMaxMs: s.number() },
  handler: async (ctx, a) => {
    const who = requirePerson(ctx, "change the execution policy");
    if (!(a.maxAttempts >= 1 && a.maxAttempts <= 20)) fail("INVALID_ARGUMENT", "maxAttempts is 1 to 20.");
    if (!(a.leaseMinMs >= 1_000 && a.leaseMaxMs <= 3_600_000 && a.leaseMinMs <= a.leaseMaxMs)) fail("INVALID_ARGUMENT", "Leases are 1 s to 1 h, min ≤ max (FeltKit's bounds).");
    const [p] = await ctx.db.find(policy, { key: "workspace" });
    const value = { key: "workspace", ...a, updatedBy: who.id, updatedAt: now() };
    if (p) await ctx.db.replace(policy, p.id, value); else await ctx.db.insert(policy, value);
  },
});

/** Check a repository connection: Handoff reads the repository from GitHub with its credential. */
export const checkConnection = app.mutation({
  access: "repos.manage",
  args: { repositoryId: s.string() },
  handler: async (ctx, { repositoryId }) => {
    requirePerson(ctx, "check a connection");
    const r = await ctx.db.get(repositories, repositoryId);
    if (!r) fail("NOT_FOUND", "No such repository.");
    const key = `repository:${repositoryId}`;
    let [state] = await ctx.db.find(sync, { key });
    if (!state) { await ctx.db.insert(sync, { key, consecutiveFailures: 0 }); [state] = await ctx.db.find(sync, { key }); }
    try {
      const repo = (await ctx.integrations.invoke("github.repoget", { owner: r.owner, repo: r.name })) as { full_name: string; default_branch: string };
      await ctx.db.patch(sync, state!.id, { lastOkAt: now(), consecutiveFailures: 0 });
      return { ok: true, fullName: repo.full_name, defaultBranch: repo.default_branch };
    } catch (e) {
      const message = `${(e as { code?: string }).code ?? "ERROR"}: ${(e as Error).message}`.slice(0, 300);
      await ctx.db.patch(sync, state!.id, { lastErrorAt: now(), lastError: message, consecutiveFailures: state!.consecutiveFailures + 1 });
      return { ok: false, error: message };
    }
  },
});

/** Runner processes Handoff has heard from (self-reported), with staleness derived from the last heartbeat. */
export const listWorkers = app.query({
  access: "agents.read",
  handler: async (ctx) => (await ctx.db.find(workers, {})).sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((w) => ({ ...w, ageMs: now() - w.lastSeenAt })),
});
