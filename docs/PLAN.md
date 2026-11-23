# Handoff v1: implementation plan

Basis: `rkendel1/felt-ops` `docs/product-discovery/` (discovery and Phase 0, through commit `3e4c6eb`).
Platform APIs were confirmed against the installed `@feltdb/feltkit` **0.3.37** type declarations
(`dist/runtime/context.d.ts`, `dist/runtime/invocations.d.ts`, `dist/app.d.ts`,
`dist/testing/index.d.ts`, `dist/server/index.js`) and the Phase 0 spikes.

## Conflicts with the brief (resolved)

| Brief says | Reality | Resolution |
|---|---|---|
| S1 was not run; keep it blocked | S1 **was** run as a scored experiment on 2026-11-23 with a valid key: EVE 10/10 and Claude Code 10/10 on `claude-sonnet-5-5`. Evidence: felt-ops `docs/product-discovery/phase-0/s1/evidence/`. Caveat: the tasks were too easy to separate the harnesses (ceiling effect) | Report S1 as **passed by its pre-registered rule, quality on realistic work unproven**. The release gate is S1b (harder tasks), not S1 |
| Primary repository `felt-ops` | The owner supplied `rkendel1/handoff` (empty) mid-task | Handoff lives here. felt-ops keeps discovery and evidence only. The CompanyOS app in felt-ops (`^0.3.34`) is untouched |
| GitHub write flows "tested" | Phase 0 S4 tested writes only against a local GitHub-API stub. Real GitHub writes were not authorized | Writes still go through `app.integration`. Automated and live write tests use the stub, and so does the demo, because the brief forbids changing external services. Reads are tested live (read-only) |

## GitHub layer decision

The owner asked to use `@appport/github` (1.0.2), then withdrew the request after review. It was not used, for these
reasons:
- It opens its own FeltDB 0.11.9 store.
- It has no idempotency or unknown-outcome handling.
- It is not a FeltKit/AppPort provider.
- It pins platform versions far older than 0.3.37.

Handoff uses FeltKit's `app.integration` (Phase 0 S4).

## Deployment model (v1)

One Handoff deployment is one workspace (no FeltKit tenancy in v1). One trusted runner pool shares
one FeltKit service principal (`runner-pool`, role `runner`); the S2 constraint is accepted by the
owner. Each runner process sends a self-chosen `instance` id. It is recorded as **asserted**
evidence, never as identity.

## Domain model

| Collection | Holds | Authority |
|---|---|---|
| `agents` | key, name, EVE definition ref, model, status | application |
| `repositories` | GitHub owner/name, default branch | application (GitHub is the truth for the repo itself) |
| `delegations` | the human's intent: objective, criteria, repo, base, requester, agent, `state`, `generation`, `invocationId`, `agentTaskId`, `branch`, `report` (runner claim), `verified` (from facts), `review` | application |
| `runEvents` | runner observations: (delegation, attempt, instance, seq, kind, text) unique on (attempt, seq) | runner-reported, never authority |
| `facts` | GitHub facts: PR, branch head, checks, with how they were observed (`via: integration` / `poll`) | external (GitHub) |
| `sync` | GitHub polling freshness: last success, last error, consecutive failures | application |
| `history` (`app.auditTrail`) | every transition, with actor and `source: person \| runner \| system \| github` | append-only evidence |

What stays in FeltKit, never duplicated:
- **FeltKit invocation** (`ctx.invocations`): attempts, claim, lease, fencing, re-claim with
  `previous`, cancel, and approval request and decision.
- **FeltKit agent task + agent control:** steering instructions, pause, resume and stop, with
  acknowledgement.
- **Integration call records:** GitHub request, outcome and idempotency.

## Delegation states

`draft → queued → dispatched → running ⇄ awaiting_approval → reported → verified → accepted`
- Side exits: `returned` (back to `queued`, generation + 1), `rejected`, `cancelled`, `failed`.
- `reported` is the runner's claim. `verified` requires a GitHub fact whose PR head equals the
  reported head commit. `accepted` requires a person, and only from `verified`.

Every transition is one function with preconditions. None depends on a model's output.

## Functions (people)

- `work.create`, `work.assign` (→ `queued`, same transaction), `work.cancel` (invocation cancel as
  the delegator, then `cancelled`).
- `work.review` (accept / return / reject).
- `agents.register`, `repositories.add`.
- `github.syncNow`.
- Queries: `desk`, `work.list`, `work.detail`, `agents.list`, `settings`.

## Functions (runner role, over MCP)

| Function | Does |
|---|---|
| `runner.next` | the next queued delegation, or a dispatched or stalled one to (re)claim |
| `runner.deliver` | bridge-surface `accept` for the delegator. Idempotent invocation id `d<id>-g<gen>` |
| `runner.claim` | `ctx.invocations.start(id, { worker: instance, leaseMs })`. Records the attempt, the asserted instance and `previous` |
| `runner.report` | `ctx.invocations.progress` (renews the lease, rejects stale claims) plus deduplicated `runEvents`. Returns the cancelled state |
| `runner.bindTask` | links the FeltKit agent task used for steering |
| `runner.requestApproval` | `transition(awaiting_approval, { approval: { action: "github.pr.open", input } })` |
| `runner.resume` | `ctx.invocations.resume`: refused by FeltKit until the delegator has approved |
| `runner.openPullRequest` (action) | holds the claim. **Approval checked at this boundary** from the invocation record's `approval.decision`. Reconciles first (`pullbyhead`): an existing PR is recorded and returned, never duplicated. Otherwise `github.pullscreate` with idempotency key `pr-d<id>-g<gen>`. An unknown outcome is recorded as `unknown` and re-verified before any retry |
| `runner.submit` | the claim: `transition(completed)`, delegation `reported`; schedules verification |
| `runner.fail` | `transition(failed)`, with `OUTCOME_UNKNOWN` when an effect may have happened |

## Jobs

`github.sync` (FeltKit jobs, self-rescheduling with `runAt`):
- polls each `reported`/`verified` delegation's PR and checks;
- records facts and freshness;
- on 403/429/5xx/outage, records the error, backs off and reschedules;
- on the next success, reconciles.

## Runner (separate package `runner/`, Node ≥ 24)

1. Polls `runner.next` over MCP as `runner-pool`.
2. deliver → claim → bindTask (`feltkit_agent_create`).
3. Clones the repo at base into a workspace and runs an **EVE** agent (`@appport/eve` 1.0.2,
   `eve build` + `eve start`, Docker sandbox, network deny-all) with the objective.
4. While the turn runs: `report` (heartbeat + events) and `feltkit_agent_checkpoint`.
   Instructions go to the EVE session; pause holds new turns; stop or cancel ends the session.
5. After the turn: copies the workspace out, commits on `handoff/d<id>-g<gen>` and pushes, all
   **outside** the sandbox (the sandbox holds no credentials).
6. `requestApproval` → waits for `resume` → `openPullRequest` → `submit`.

## Tests (FeltKit `createTestApp` + a local GitHub-API stub)

**Mandatory recovery scenario:** Runner A claims → opens a PR (the stub creates it, then drops the
connection) → A crashes → lease expires → B claims attempt 2 → reconcile finds A's PR → no duplicate
→ submit → poll verifies → person accepts. The history shows each step.

Also covered:
- duplicate delivery;
- crash;
- renewal and expiry;
- stale reports;
- cancellation;
- steering acknowledgement (published agent control);
- approval enforcement (runner can't approve; open PR refused without a decision);
- authorization boundaries;
- 429/503 polling;
- unknown write and verification;
- reconnect reconciliation;
- out-of-order and duplicate events;
- partial execution with failed recovery.

**Live:** a FeltKit server with two runner processes using real EVE (Anthropic key), killing
runner A after PR creation.

## Known gaps carried in

- **E-1:** per-runner identity (shared pool accepted).
- **E-2:** approval of agent-owned AgentHost actions is Studio-only. v1 uses invocation approval
  instead, which the delegator decides in-app.
- **E-4:** GitHub-native webhooks (polling instead).
- No usage metering.
- No multi-workspace tenancy in v1.
