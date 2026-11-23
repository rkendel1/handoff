/**
 * Test setup: a real FeltKit test app (its own FeltDB instance) wired to a local GitHub-API stub
 * through FeltKit's own integration configuration (GITHUB_API_URL, FELTKIT_CREDENTIAL_GITHUB).
 */
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../../feltkit/_generated/api.js";
// @ts-expect-error plain ESM helper shared with the live scenario
import { startGitHubStub } from "./github-stub.mjs";

export const TOKEN = "test-github-token-never-recorded";
export const ada = { id: "ada", type: "user" as const, roles: ["member", "admin"] };
export const lin = { id: "lin", type: "user" as const, roles: ["member"] };
export const pool = { id: "runner-pool", type: "service" as const, roles: ["runner"] };

export type Stub = Awaited<ReturnType<typeof startGitHubStub>> & {
  setBranch(b: string, sha: string): void; dropNextCreate(): void; dropBeforeCreate(): void; setStatus(code: number | null): void; mergePull(n: number): void;
  counts: { pullsCreated: number; createRequests: number; requests: number; rejectedAuth: number };
  log: Array<{ method: string; path: string; query: string; idempotencyKey: string | null; auth: string }>;
  pulls: Array<{ number: number; head: string; state: string }>;
  setIssue(n: number, issue: { title: string; body: string }): void;
  url: string; close(): Promise<void>;
};

export async function boot() {
  const stub = (await startGitHubStub({ token: TOKEN })) as Stub;
  process.env.GITHUB_API_URL = stub.url;
  process.env.FELTKIT_CREDENTIAL_GITHUB = TOKEN;
  const t = await createTestApp();
  const person = t.as("ada");
  const runner = t.as("runner-pool");
  await person.mutation(api.admin.registerAgent, { key: "coder", name: "Coder", definition: "eve:runner/agent", model: "anthropic:claude-sonnet-5-5" });
  const repositoryId = await person.mutation(api.admin.addRepository, { owner: "acme", name: "ledger", defaultBranch: "main" });
  stub.setBranch("main", "base000");
  const close = async () => { await t.close(); await stub.close(); };
  return { t, stub, person, runner, repositoryId, close };
}

/** A delegation, created and assigned by Ada, delivered by the pool. */
export async function delegated(ctx: Awaited<ReturnType<typeof boot>>, title = "Fix negative money formatting") {
  const id = await ctx.person.mutation(api.work.create, { title, objective: "formatMoney(-500) must print -$5.00.", criteria: ["Existing tests pass"], repositoryId: ctx.repositoryId });
  await ctx.person.mutation(api.work.assign, { id, agentKey: "coder" });
  const { invocationId } = await ctx.runner.mutation(api.runner.deliver, { delegationId: id });
  return { id, invocationId };
}

export async function claimAs(ctx: Awaited<ReturnType<typeof boot>>, delegationId: string, instance: string, leaseMs = 60_000) {
  return (await ctx.runner.mutation(api.runner.claim, { delegationId, instance, leaseMs })) as { proceed: boolean; claim?: string; attemptId?: string; attemptNumber?: number; previous?: Array<{ attempt: string; outcome: string }>; reason?: string; snapshot?: { delegation: { branch: string } } };
}

/** The person approves exactly what was asked, through FeltKit's own approval (the HTTP route calls the same). */
export async function approve(ctx: Awaited<ReturnType<typeof boot>>, invocationId: string, who = ada) {
  const inv = await ctx.t.runtime.invocations.get(who, invocationId);
  return ctx.t.runtime.invocations.approve(who, invocationId, { digest: inv.approval!.digest });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { api };
