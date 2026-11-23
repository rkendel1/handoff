/** Workspace administration: agents and repositories. */
import { fail, s } from "@feltdb/feltkit";
import { agents, app, history, repositories, sync } from "./app.js";
import { requirePerson } from "./_lib.js";

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
    const [githubSync] = await ctx.db.find(sync, { key: "github" });
    return {
      githubSync: githubSync ?? null,
      runnerIdentity: "One shared runner principal (runner-pool) for one trusted pool. Runner instance ids are asserted, not authenticated; runners cannot be attributed or revoked individually.",
    };
  },
});
