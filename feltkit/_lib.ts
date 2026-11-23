/** Shared domain rules (not a function module: leading underscore). */
import { fail } from "@feltdb/feltkit";
import type { MutationCtx, QueryCtx } from "@feltdb/feltkit";
import { delegations, history, policy, repositories } from "./app.js";

export type Source = "person" | "runner" | "system" | "github";
export type DelegationState = (typeof import("./app.js").DELEGATION_STATES)[number];

export const now = () => Date.now();

/** States from which each state may be entered. The single place transitions are allowed. */
const ALLOWED: Record<DelegationState, readonly DelegationState[]> = {
  draft: [],
  queued: ["draft", "verified", "reported", "failed"], // assign; or a person returns work (new generation)
  dispatched: ["queued"],
  running: ["dispatched", "running", "awaiting_approval", "failed"], // claim, re-claim, resume, recovery
  awaiting_approval: ["running"],
  reported: ["running"],
  verified: ["reported", "verified"],
  accepted: ["verified"],
  rejected: ["reported", "verified", "failed"],
  cancelled: ["draft", "queued", "dispatched", "running", "awaiting_approval"],
  failed: ["running", "dispatched", "awaiting_approval"],
};

export async function load(ctx: QueryCtx | MutationCtx, id: string) {
  const d = await ctx.db.get(delegations, id);
  if (!d) fail("NOT_FOUND", `No delegation ${id}.`);
  return d;
}

export async function repoOf(ctx: QueryCtx | MutationCtx, repositoryId: string) {
  const r = await ctx.db.get(repositories, repositoryId);
  if (!r) fail("FAILED_PRECONDITION", `Repository ${repositoryId} is not connected.`);
  return r;
}

/** Move a delegation to `to` if the transition is allowed, and record it in the same transaction. */
export async function transition(
  ctx: MutationCtx,
  d: { id: string; state: DelegationState },
  to: DelegationState,
  source: Source,
  type: string,
  data: Record<string, unknown> = {},
  patch: Record<string, unknown> = {},
) {
  if (!ALLOWED[to].includes(d.state)) fail("FAILED_PRECONDITION", `Delegation is ${d.state}; it cannot become ${to}.`);
  await ctx.db.patch(delegations, d.id, { ...patch, state: to, updatedAt: now() });
  await history.record(ctx, { subject: "delegation", id: d.id, type, data: { source, from: d.state, to, ...data } });
}

export async function note(ctx: MutationCtx, id: string, source: Source, type: string, data: Record<string, unknown> = {}) {
  await history.record(ctx, { subject: "delegation", id, type, data: { source, ...data } });
}

export function requirePerson(ctx: QueryCtx | MutationCtx, why: string) {
  const p = ctx.auth.requirePrincipal();
  if (p.type !== "user") fail("FORBIDDEN", `Only a person may ${why}.`);
  return p;
}

export const branchFor = (d: { number: number; generation: number }) => `handoff/d${d.number}-g${d.generation}`;
export const invocationKey = (d: { id: string; generation: number }) => `d${d.id}-g${d.generation}`;

/** Policy defaults until an admin sets them (Settings). */
export const DEFAULT_POLICY = { maxAttempts: 3, leaseMinMs: 2_000, leaseMaxMs: 600_000 } as const;

export async function policyOf(ctx: QueryCtx | MutationCtx) {
  const [p] = await ctx.db.find(policy, { key: "workspace" });
  return { maxAttempts: p?.maxAttempts ?? DEFAULT_POLICY.maxAttempts, leaseMinMs: p?.leaseMinMs ?? DEFAULT_POLICY.leaseMinMs, leaseMaxMs: p?.leaseMaxMs ?? DEFAULT_POLICY.leaseMaxMs };
}

/**
 * Runtime capabilities a runner may declare, and what each value means. Displayed and used to enable
 * controls; never used for authorization (the runner's declaration is its own claim).
 */
export const RUNTIME_CAPABILITIES = {
  steer: ["next-step", "none"],
  pause: ["between-steps", "none"],
  interrupt: ["cancel-generation", "none"],
  resume: ["continue", "none"],
  stop: ["cooperative", "none"],
  reconnect: ["resume-session", "none"],
} as const;
