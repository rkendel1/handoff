/**
 * GitHub facts and the one consequential GitHub effect (opening a pull request).
 *
 * Rules:
 *   - Facts are written only from Handoff's own reads of GitHub, never from a caller's arguments,
 *     so a runner can trigger an observation but cannot forge one.
 *   - Opening a pull request requires the delegating person's approval, checked here, at the
 *     execution boundary, from FeltKit's invocation record (not from anything the runner says).
 *   - Before creating, Handoff looks for an existing pull request for the branch (reconciliation):
 *     a previous attempt may have created one without being able to report it.
 *   - An unknown write outcome is recorded as unknown and verified by a read; it is never assumed.
 *   - Polling (jobs), not webhooks: AppPort inbound webhooks refuse GitHub's signature format.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { app, delegations, facts, sync } from "./app.js";
import { load, note, now, repoOf, transition } from "./_lib.js";

type Pull = { number: number; state: string; html_url?: unknown; merged?: unknown; head: { ref: string; sha: string }; base: { ref: string } };

const POLL_MS = Number(process.env.HANDOFF_POLL_MS ?? 30_000);
const MAX_BACKOFF_MS = 15 * 60_000;

/** Read the delegation branch's pull requests from GitHub and record what GitHub says. */
async function observe(ctx: MutationCtx, delegationId: string) {
  const d = await load(ctx, delegationId);
  const repo = await repoOf(ctx, d.repositoryId);
  const pulls = (await ctx.integrations.invoke("github.pullsbyhead", { owner: repo.owner, repo: repo.name, head: `${repo.owner}:${d.branch}`, state: "all" })) as Pull[];
  const pr = pulls.filter((p) => p.head.ref === d.branch).sort((a, b) => a.number - b.number)[0] ?? null;
  if (!pr) return { d, pr: null as Pull | null, factId: null as string | null, count: 0 };
  const prior = (await ctx.db.find(facts, { delegationId, kind: "pull_request" })).sort((a, b) => b.observedAt - a.observedAt)[0];
  let factId = prior?.id ?? null;
  const merged = pr.merged === true ? "merged" : pr.state;
  if (!prior || prior.prNumber !== pr.number || prior.headSha !== pr.head.sha || prior.state !== merged) {
    factId = await ctx.db.insert(facts, { delegationId, kind: "pull_request", via: "read", prNumber: pr.number, headSha: pr.head.sha, state: merged, url: typeof pr.html_url === "string" ? pr.html_url : undefined, detail: { duplicatesOnBranch: pulls.length - 1 }, observedAt: now() });
    await note(ctx, delegationId, "github", "github.pr.observed", { prNumber: pr.number, headSha: pr.head.sha, state: merged, factId });
  }
  return { d, pr, factId, count: pulls.filter((p) => p.head.ref === d.branch).length };
}

type Compare = { status?: unknown; ahead_by?: unknown; total_commits?: unknown; commits: Array<{ sha: string; commit: { message: string } }>; files?: unknown };
const PATCH_LIMIT = 4_000; const PATCH_TOTAL = 60_000;

/**
 * Source-control evidence for the delegation's branch, read from GitHub: commits and changed files
 * (base...head by commit SHA), reviews and check runs on the PR head. Recorded only when it changed.
 * GitHub stays authoritative; these are dated observations of it.
 */
async function observeSourceControl(ctx: MutationCtx, delegationId: string, pr: Pull | null) {
  const d = await load(ctx, delegationId);
  const repo = await repoOf(ctx, d.repositoryId);
  const base = (await ctx.integrations.invoke("github.branchget", { owner: repo.owner, repo: repo.name, branch: d.baseBranch })) as { commit: { sha: string } };
  const head = pr?.head.sha ?? ((await ctx.integrations.invoke("github.branchget", { owner: repo.owner, repo: repo.name, branch: d.branch }).catch(() => null)) as { commit: { sha: string } } | null)?.commit.sha;
  if (!head) return;
  const cmp = (await ctx.integrations.invoke("github.compare", { owner: repo.owner, repo: repo.name, basehead: `${base.commit.sha}...${head}` })) as Compare;
  let budget = PATCH_TOTAL;
  const files = (Array.isArray(cmp.files) ? cmp.files : []).map((f: { filename: string; status: string; additions: number; deletions: number; patch?: string }) => {
    const patch = typeof f.patch === "string" ? f.patch.slice(0, Math.max(0, Math.min(PATCH_LIMIT, budget))) : undefined;
    budget -= patch?.length ?? 0;
    return { filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch, truncated: typeof f.patch === "string" && (patch?.length ?? 0) < f.patch.length };
  });
  const latest = async (kind: string) => (await ctx.db.find(facts, { delegationId, kind: kind as never })).sort((a, b) => b.observedAt - a.observedAt)[0];
  const record = async (kind: "diff" | "commits" | "reviews" | "checks", detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const prior = await latest(kind);
    if (prior && JSON.stringify(prior.detail) === JSON.stringify(detail) && prior.headSha === head) return;
    await ctx.db.insert(facts, { delegationId, kind, via: "read", headSha: head, ...extra, detail, observedAt: now() });
    await note(ctx, delegationId, "github", `github.${kind}.observed`, { headSha: head, ...extra });
  };
  await record("diff", { base: base.commit.sha, head, files });
  await record("commits", { commits: cmp.commits.map((c) => ({ sha: c.sha, message: c.commit.message.split("\n")[0]!.slice(0, 200) })) });
  const checks = (await ctx.integrations.invoke("github.checkruns", { owner: repo.owner, repo: repo.name, ref: head })) as { total_count: number; check_runs: Array<{ name: string; status: string; conclusion: unknown }> };
  const runs = checks.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null }));
  const state = runs.length === 0 ? "none" : runs.some((c) => c.status !== "completed") ? "pending" : runs.every((c) => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral") ? "passing" : "failing";
  await record("checks", { runs }, { state });
  if (pr) {
    const reviews = (await ctx.integrations.invoke("github.pullreviews", { owner: repo.owner, repo: repo.name, number: pr.number })) as Array<{ state: string; user: unknown; submitted_at: unknown }>;
    const list = reviews.map((r) => ({ state: r.state, by: (r.user as { login?: string } | null)?.login ?? null, at: r.submitted_at ?? null }));
    const reviewState = list.some((r) => r.state === "CHANGES_REQUESTED") ? "changes_requested" : list.some((r) => r.state === "APPROVED") ? "approved" : list.length ? "commented" : "none";
    await record("reviews", { reviews: list }, { prNumber: pr.number, state: reviewState });
  }
}

/** Read the branch's source-control evidence from GitHub now (diff, commits, checks, reviews). */
export const observeSourceControlNow = app.mutation({
  access: "github.read",
  args: { delegationId: s.string() },
  returns: s.boolean(),
  capability: { name: "github.sourcecontrol", description: "Read the delegation branch's diff, commits, checks and reviews from GitHub." },
  handler: async (ctx, { delegationId }) => { const { pr } = await observe(ctx, delegationId); await observeSourceControl(ctx, delegationId, pr); return true; },
});

/** Anyone allowed to read GitHub may ask Handoff to look; what is recorded is what GitHub says. */
export const observePulls = app.mutation({
  access: "github.read",
  args: { delegationId: s.string() },
  returns: s.unknown(),
  capability: { name: "github.observe", description: "Read the delegation branch's pull request from GitHub and record it." },
  handler: async (ctx, { delegationId }) => {
    const { pr, factId, count } = await observe(ctx, delegationId);
    return pr ? { number: pr.number, headSha: pr.head.sha, state: pr.state, factId, pullRequestsOnBranch: count } : null;
  },
});

/**
 * Open the delegation's pull request, once. Called by the runner holding the current claim.
 * Order: claim is current → the person approved this exact branch and head → reconcile (an
 * existing PR is adopted, never duplicated) → create with an idempotency key → on an unknown
 * outcome, verify by reading before answering.
 *
 * A mutation (FeltKit refuses actions as AppPort capabilities). If FeltKit retries it after a
 * conflict, step 3 runs again first, so a PR created by an earlier execution is adopted, not repeated;
 * the idempotency key and FeltKit's integration-call record are a second guard.
 */
export const openPullRequest = app.mutation({
  access: "runner.work",
  args: { delegationId: s.string(), claim: s.string(), headSha: s.string(), body: s.string({ maxLength: 8000 }) },
  returns: s.unknown(),
  capability: { name: "runner.openpullrequest", description: "Open the delegation's pull request (approval required; reconciles first)." },
  handler: async (ctx, { delegationId, claim, headSha, body }) => {
    const p = ctx.auth.requirePrincipal();
    if (p.type === "user") fail("FORBIDDEN", "Runner capability.");
    const d = await load(ctx, delegationId);
    const repo = await repoOf(ctx, d.repositoryId);
    if (!d.invocationId) fail("FAILED_PRECONDITION", "Not delivered.");
    // 1. The caller holds the current claim (a stale or cancelled attempt is refused by FeltKit).
    await ctx.invocations.progress(d.invocationId, { claim, note: "open pull request" });
    // 2. Approval, at the execution boundary, from FeltKit's record.
    const inv = await ctx.invocations.get(d.invocationId);
    const approval = inv.approval;
    const input = (approval?.input ?? {}) as { branch?: string; headSha?: string };
    if (!approval?.decision || approval.action !== "github.pr.open") fail("FORBIDDEN", "Opening a pull request needs the delegating person's approval (APPROVAL_REQUIRED).");
    if (input.branch !== d.branch || input.headSha !== headSha) fail("FORBIDDEN", `The approval was for ${String(input.branch)} at ${String(input.headSha)}, not ${d.branch} at ${headSha} (APPROVAL_MISMATCH).`);
    // 3. Reconcile with GitHub first.
    const existing = await observe(ctx, delegationId);
    if (existing.pr) {
      await note(ctx, d.id, "system", "github.pr.reconciled", { prNumber: existing.pr.number, headSha: existing.pr.head.sha, created: false });
      return { created: false, reconciled: true, prNumber: existing.pr.number, headSha: existing.pr.head.sha };
    }
    // 4. Create, once per generation.
    try {
      await ctx.integrations.invoke("github.pullscreate", { owner: repo.owner, repo: repo.name, title: `#${d.number} ${d.title}`.slice(0, 250), head: d.branch, base: d.baseBranch, body }, { idempotencyKey: `pr-${d.id}-g${d.generation}` });
    } catch (error) {
      // FeltKit's OUTCOME_UNKNOWN, or AppPort's idempotency guard refusing to re-send an unknown call.
      const e = error as { code?: string; message?: string; details?: { reason?: string } };
      const reason = String(e.details?.reason ?? "");
      const unknown = e.code === "OUTCOME_UNKNOWN" || reason === "IDEMPOTENCY_OUTCOME_UNKNOWN" || /OUTCOME_UNKNOWN|without a known outcome/.test(String(e.message));
      if (!unknown) throw error;
      // Unknown: record it, then verify by reading. Never assume either way.
      await ctx.db.insert(facts, { delegationId, kind: "unknown_write", via: "integration-response", detail: { operation: "github.pullscreate", code: reason || String(e.code) }, observedAt: now() });
      await note(ctx, d.id, "system", "github.write.unknown", { operation: "github.pullscreate", code: reason || String(e.code) });
      const verified = await observe(ctx, delegationId).catch(() => null);
      if (verified?.pr) return { created: true, verifiedAfterUnknown: true, prNumber: verified.pr.number, headSha: verified.pr.head.sha };
      return { created: null, outcome: "unknown", message: "The request was sent but its outcome is unknown and GitHub does not show a pull request yet. Reconcile before retrying." };
    }
    const after = await observe(ctx, delegationId);
    if (!after.pr) return { created: null, outcome: "unknown", message: "GitHub accepted the request but does not show the pull request yet." };
    await note(ctx, d.id, "system", "github.pr.created", { prNumber: after.pr.number, headSha: after.pr.head.sha });
    return { created: true, prNumber: after.pr.number, headSha: after.pr.head.sha };
  },
});

export const invocationOf = app.query({
  access: "runner.work",
  args: { delegationId: s.string() },
  handler: async (ctx, { delegationId }) => {
    const d = await load(ctx, delegationId);
    if (!d.invocationId) fail("FAILED_PRECONDITION", "Not delivered.");
    return { invocationId: d.invocationId };
  },
});

/** Verify a reported delegation against GitHub: its PR's head must be the reported commit. */
export const verify = app.mutation({
  access: "github.read",
  args: { delegationId: s.string() },
  returns: s.unknown(),
  capability: { name: "github.verify", description: "Verify a reported delegation against GitHub." },
  handler: async (ctx, { delegationId }) => verifyOne(ctx, delegationId),
});

async function verifyOne(ctx: MutationCtx, delegationId: string) {
  const { d, pr, factId } = await observe(ctx, delegationId);
  await observeSourceControl(ctx, delegationId, pr);
  if (!["reported", "verified"].includes(d.state) || !d.report) return { verified: false, reason: `delegation is ${d.state}` };
  if (!pr || !factId) return { verified: false, reason: "no pull request on GitHub for the branch" };
  if (pr.state === "closed" && pr.merged !== true) {
    // Someone closed it on GitHub without merging. Handoff does not open a second PR for this generation:
    // the delegator decides (request changes starts a new generation and branch; reject ends it).
    await note(ctx, d.id, "github", "verification.closed", { prNumber: pr.number, headSha: pr.head.sha });
    return { verified: false, reason: "the pull request was closed on GitHub without merging" };
  }
  if (pr.head.sha !== d.report.headSha) {
    await note(ctx, d.id, "github", "verification.mismatch", { reported: d.report.headSha, observed: pr.head.sha, prNumber: pr.number });
    return { verified: false, reason: "the pull request's head is not the reported commit" };
  }
  if (d.state === "verified" && d.verified?.headSha === pr.head.sha) return { verified: true, unchanged: true };
  await transition(ctx, d, "verified", "github", "result.verified", { prNumber: pr.number, headSha: pr.head.sha, factId }, { verified: { prNumber: pr.number, headSha: pr.head.sha, at: now(), factId } });
  return { verified: true, prNumber: pr.number };
}

/**
 * Polling job (FeltKit jobs). Verifies reported work and refreshes verified work. Records freshness;
 * on GitHub errors (rate limit, outage) it records the failure and backs off; the next success
 * reconciles everything that changed meanwhile. One chain: a job whose `chain` is stale does nothing.
 */
export const syncTick = app.mutation({
  access: "github.sync",
  args: { reason: s.optional(s.string()), chain: s.optional(s.string()) },
  handler: async (ctx, { chain }) => {
    let [state] = await ctx.db.find(sync, { key: "github" });
    if (!state) { await ctx.db.insert(sync, { key: "github", consecutiveFailures: 0 }); [state] = await ctx.db.find(sync, { key: "github" }); }
    const at = now();
    if (chain && state!.nextAt && String(state!.nextAt) !== chain) return { skipped: "stale chain" };
    const pending = (await ctx.db.find(delegations, {})).filter((d) => d.state === "reported" || d.state === "verified");
    let error: string | null = null; let checked = 0;
    for (const d of pending) {
      try { await verifyOne(ctx, d.id); checked++; } catch (e) { error = `${(e as { code?: string }).code ?? "ERROR"}: ${(e as Error).message}`.slice(0, 300); break; }
    }
    const failures = error ? state!.consecutiveFailures + 1 : 0;
    const delay = error ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures, 6)) : POLL_MS;
    const nextAt = pending.length || error ? at + delay : undefined;
    await ctx.db.patch(sync, state!.id, { ...(error ? { lastErrorAt: at, lastError: error } : { lastOkAt: at }), consecutiveFailures: failures, nextAt });
    if (nextAt) ctx.afterCommit.jobs.enqueue("github.sync", { chain: String(nextAt) }, { runAt: new Date(nextAt).toISOString() });
    return { checked, pending: pending.length, error, nextAt: nextAt ?? null };
  },
});

/** Run a sync now (a person, the runner pool, or a test). */
export const syncNow = app.mutation({
  access: "github.sync",
  handler: async (ctx) => {
    ctx.afterCommit.jobs.enqueue("github.sync", { reason: "requested" });
    return true;
  },
});

