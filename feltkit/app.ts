/**
 * Handoff: a system of record for delegated software work.
 *
 * One deployment is one workspace. Durable state is this app's FeltDB instance. What FeltKit already
 * owns is used, never re-implemented:
 *   - execution attempts, claims, leases, fencing, cancel and approval: the FeltKit invocation
 *     (ctx.invocations) behind the `delegation` bridge surface;
 *   - steering (instructions, pause, resume, stop): FeltKit agent control on the runner's agent task;
 *   - GitHub calls, idempotency and unknown outcomes: app.integration("github"), callable by app code only.
 *
 * Runner identity: one trusted runner pool shares the `runner` role and one service principal per
 * deployment. A runner instance id is recorded as asserted evidence, never as identity.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "handoff",
  version: "0.1.0",
  description: "Handoff: durable, verifiable, recoverable delegation of software work to agents.",
  roles: {
    // People who delegate, steer and review. feltkit.agent.* lets them steer a runner's agent task.
    member: ["work.*", "agents.read", "repos.read", "github.read", "notifications.*", "feltkit.agent.*", "handoff.placed"],
    // Workspace administration: agents, repositories, GitHub polling, platform services.
    admin: ["agents.manage", "repos.manage", "github.read", "github.sync", "jobs.*", "credential.*", "feltkit.operations.*"],
    // The trusted runner pool (one shared service principal). Also the bridge role of the
    // `delegation` surface. It never holds work.review or any approval permission.
    runner: ["runner.*", "github.read", "github.write", "github.sync", "jobs.create", "jobs.execute", "feltkit.agent.*", "handoff.placed", "agents.read", "repos.read"],
  },
  auth: { accounts: { roles: ["member"], signUp: false }, onSessionEnd: "runner:sessionEnded" },
  dev: {
    users: [
      { id: "ada", name: "Ada (delegator, admin)", roles: ["member", "admin"] },
      { id: "lin", name: "Lin (member)", roles: ["member"] },
      { id: "runner-pool", name: "Runner pool (shared)", type: "service", roles: ["runner"] },
    ],
  },
  services: {
    notifications: { types: ["approval.requested", "review.requested", "attention.needed"] },
    jobs: { handlers: { "handoff.placed": "runner:placed", "github.sync": "github:syncTick" } },
  },
  activity: { retain: 20000 },
});

// ───────────────────────── Registry ─────────────────────────

export const agents = app.collection("agents", {
  key: s.string({ minLength: 2, maxLength: 40 }),
  name: s.string(),
  /** Where the agent's behaviour is defined (an EVE agent directory), e.g. "eve:runner/agent@<commit>". */
  definition: s.string(),
  model: s.string(),
  status: s.enum(["active", "suspended"]),
}, { unique: [["key"]] });

export const repositories = app.collection("repositories", {
  owner: s.string(),
  name: s.string(),
  defaultBranch: s.string(),
}, { unique: [["owner", "name"]] });

// ───────────────────────── Delegation ─────────────────────────

export const DELEGATION_STATES = ["draft", "queued", "dispatched", "running", "awaiting_approval", "reported", "verified", "accepted", "rejected", "cancelled", "failed"] as const;

export const delegations = app.collection("delegations", {
  number: s.number(),
  title: s.string({ minLength: 3, maxLength: 200 }),
  objective: s.string({ minLength: 3, maxLength: 1800 }),
  criteria: s.array(s.string()),
  repositoryId: s.string(),
  baseBranch: s.string(),
  /** A linked GitHub issue (GitHub stays authoritative for it). */
  issueNumber: s.optional(s.number()),
  requestedBy: s.string(),
  agentKey: s.optional(s.string()),
  state: s.enum(DELEGATION_STATES),
  /** Incremented when a person returns work for more: each generation is one FeltKit invocation. */
  generation: s.number(),
  invocationId: s.optional(s.string()),
  /** The FeltKit agent task the runner opened for steering (agent control). */
  agentTaskId: s.optional(s.string()),
  branch: s.string(),
  /** The runner's claim of completion. Never authority. */
  report: s.optional(s.object({ summary: s.string(), headSha: s.string(), at: s.number(), instance: s.string() })),
  /** Set only from GitHub facts (see github.ts verify). */
  verified: s.optional(s.object({ prNumber: s.number(), headSha: s.string(), at: s.number(), factId: s.string() })),
  /** The latest runtime state the runner reported (session, turn, control mode, declared capabilities). Asserted. */
  runtime: s.optional(s.object({ instance: s.string(), attempt: s.string(), session: s.optional(s.string()), turn: s.optional(s.string()), mode: s.optional(s.string()), capabilities: s.record(s.string()), at: s.number() })),
  /** A person's decision. */
  review: s.optional(s.object({ decision: s.enum(["accepted", "returned", "rejected"]), by: s.string(), at: s.number(), note: s.string() })),
  failure: s.optional(s.object({ code: s.string(), message: s.string(), at: s.number() })),
  createdAt: s.number(),
  updatedAt: s.number(),
}, { unique: [["number"]], indexes: [{ fields: ["state"] }, { fields: ["requestedBy"] }] });

/** What a runner says happened. Evidence of activity, never authority. Idempotent on (attempt, seq). */
export const runEvents = app.collection("runEvents", {
  delegationId: s.string(),
  attempt: s.string(),
  /** Self-reported runner instance id (asserted, not authenticated). */
  instance: s.string(),
  seq: s.number(),
  kind: s.enum(["progress", "tool", "command", "test", "message", "warning", "error"]),
  text: s.string({ maxLength: 4000 }),
  /** The runtime session (EVE session id) and turn this event belongs to, as the runner reports them. */
  session: s.optional(s.string()),
  turn: s.optional(s.string()),
  /** For tool and command events: the runner's reported status (requested, running, completed, failed). */
  status: s.optional(s.string()),
  at: s.number(),
  receivedAt: s.number(),
}, { unique: [["attempt", "seq"]], indexes: [{ fields: ["delegationId"] }] });

/**
 * Runner processes seen by Handoff, from their own heartbeats. Everything here is self-reported by
 * the shared runner-pool principal: it describes, it does not authenticate (no per-runner identity).
 */
export const workers = app.collection("workers", {
  instance: s.string({ minLength: 1, maxLength: 80 }),
  state: s.enum(["idle", "working", "stopping"]),
  runtime: s.object({ name: s.string(), version: s.string(), node: s.string(), model: s.optional(s.string()) }),
  /** Runtime capabilities the runner declares (see RUNTIME_CAPABILITIES). */
  capabilities: s.record(s.string()),
  delegationId: s.optional(s.string()),
  attempt: s.optional(s.string()),
  session: s.optional(s.string()),
  lastError: s.optional(s.string()),
  /**
   * The FeltKit session the heartbeat arrived on (ctx.auth.session.ref): observed by the server, not asserted.
   * Distinguishes runners that hold separate pool sessions; it is not a separate principal (all share runner-pool).
   */
  sessionRef: s.optional(s.string()),
  /** Set when FeltKit ends that session (auth.onSessionEnd): revoked, expired, signed out or rotated. */
  sessionEnded: s.optional(s.object({ reason: s.string(), at: s.number() })),
  firstSeenAt: s.number(),
  lastSeenAt: s.number(),
}, { unique: [["instance"]] });

/** Governing policy for delegated work (one record, key "workspace"). Enforced at the action boundaries. */
export const policy = app.collection("policy", {
  key: s.string(),
  /** Execution attempts per generation before the work fails (enforced at claim). */
  maxAttempts: s.number(),
  /** Lease bounds a runner may ask for (enforced at claim and resume). */
  leaseMinMs: s.number(),
  leaseMaxMs: s.number(),
  updatedBy: s.optional(s.string()),
  updatedAt: s.optional(s.number()),
}, { unique: [["key"]] });

/** What GitHub said, observed by Handoff itself. Never taken from a runner's arguments. */
export const facts = app.collection("facts", {
  delegationId: s.string(),
  kind: s.enum(["pull_request", "branch", "checks", "issue", "unknown_write", "diff", "commits", "reviews", "repository"]),
  /** How Handoff learned it: the response of its own call, or a read it made (poll / reconcile). */
  via: s.enum(["integration-response", "read"]),
  prNumber: s.optional(s.number()),
  headSha: s.optional(s.string()),
  state: s.optional(s.string()),
  url: s.optional(s.string()),
  detail: s.optional(s.record(s.unknown())),
  observedAt: s.number(),
}, { indexes: [{ fields: ["delegationId"] }] });

/** GitHub polling freshness (one record, key "github"). */
export const sync = app.collection("sync", {
  key: s.string(),
  lastOkAt: s.optional(s.number()),
  lastErrorAt: s.optional(s.number()),
  lastError: s.optional(s.string()),
  consecutiveFailures: s.number(),
  nextAt: s.optional(s.number()),
}, { unique: [["key"]] });

/** Every transition, with its source: person | runner | system | github. Append-only. */
export const history = app.auditTrail("history", { subjects: ["delegation", "agent", "repository"] as const });

// ───────────────────────── Surface ─────────────────────────

/**
 * Work reaches execution through this bridge surface: the trusted runner pool delivers it for the
 * delegating person (Phase 0 S2: only the deliverer and the person can see an invocation).
 */
export const delegationSurface = app.surface("delegation", { version: "1.0.0", delivery: "bridge", bridge: { role: "runner" }, modes: ["summon", "status"], context: ["text"], returns: ["app"] });

// ───────────────────────── GitHub ─────────────────────────

const pull = s.object({ number: s.number(), state: s.string(), html_url: s.unknown(), merged: s.unknown(), head: s.object({ ref: s.string(), sha: s.string() }), base: s.object({ ref: s.string() }) });

/**
 * GitHub REST, for application code only (`expose: false`): no session, runner included, can call
 * these as capabilities. Polling, not webhooks (AppPort inbound webhooks refuse GitHub's signature
 * format: Phase 0 S4).
 */
export const github = app.integration("github", {
  description: "GitHub REST API: authoritative for branches, pull requests and checks.",
  baseUrl: { env: "GITHUB_API_URL", development: "https://api.github.com" },
  credential: "credential-ref:github",
  timeoutMs: 15000,
  expose: false,
  operations: {
    pullsbyhead: { method: "GET", path: "/repos/{owner}/{repo}/pulls", input: { owner: s.string(), repo: s.string(), head: s.string(), state: s.string() }, output: s.array(pull), effect: "observation", access: "github.read" },
    pullget: { method: "GET", path: "/repos/{owner}/{repo}/pulls/{number}", input: { owner: s.string(), repo: s.string(), number: s.number() }, output: pull, effect: "observation", access: "github.read" },
    branchget: { method: "GET", path: "/repos/{owner}/{repo}/branches/{branch}", input: { owner: s.string(), repo: s.string(), branch: s.string() }, output: s.object({ name: s.string(), commit: s.object({ sha: s.string() }) }), effect: "observation", access: "github.read" },
    checkruns: { method: "GET", path: "/repos/{owner}/{repo}/commits/{ref}/check-runs", input: { owner: s.string(), repo: s.string(), ref: s.string() }, output: s.object({ total_count: s.number(), check_runs: s.array(s.object({ name: s.string(), status: s.string(), conclusion: s.unknown() })) }), effect: "observation", access: "github.read" },
    issueget: { method: "GET", path: "/repos/{owner}/{repo}/issues/{number}", input: { owner: s.string(), repo: s.string(), number: s.number() }, output: s.object({ number: s.number(), title: s.string(), body: s.unknown(), state: s.string() }), effect: "observation", access: "github.read" },
    repoget: { method: "GET", path: "/repos/{owner}/{repo}", input: { owner: s.string(), repo: s.string() }, output: s.object({ full_name: s.string(), default_branch: s.string(), private: s.unknown() }), effect: "observation", access: "github.read" },
    compare: { method: "GET", path: "/repos/{owner}/{repo}/compare/{basehead}", input: { owner: s.string(), repo: s.string(), basehead: s.string() }, output: s.object({ status: s.unknown(), ahead_by: s.unknown(), total_commits: s.unknown(), commits: s.array(s.object({ sha: s.string(), commit: s.object({ message: s.string() }) })), files: s.unknown() }), effect: "observation", access: "github.read" },
    pullreviews: { method: "GET", path: "/repos/{owner}/{repo}/pulls/{number}/reviews", input: { owner: s.string(), repo: s.string(), number: s.number() }, output: s.array(s.object({ id: s.unknown(), state: s.string(), user: s.unknown(), submitted_at: s.unknown() })), effect: "observation", access: "github.read" },
    pullscreate: {
      method: "POST", path: "/repos/{owner}/{repo}/pulls",
      input: { owner: s.string(), repo: s.string(), title: s.string(), head: s.string(), base: s.string(), body: s.string() },
      output: pull, effect: "consequential", access: "github.write", idempotencyHeader: "Idempotency-Key",
    },
  },
});
