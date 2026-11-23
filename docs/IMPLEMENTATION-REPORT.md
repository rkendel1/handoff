# Handoff v1: implementation report

Built 2026-11-23 on `@feltdb/feltkit` **0.3.37 (exact pin)**, Node 22 for the app, and `@appport/eve` **1.0.2** on
Node 24 for the runner. Product basis: `rkendel1/felt-ops` `docs/product-discovery/`. Plan: [PLAN.md](PLAN.md).
**Not production-ready**: see "Before a real pilot".

## Status at a glance

| Requirement | Status | Evidence |
|---|---|---|
| A person creates (or imports from a GitHub issue) and delegates work | Implemented; automated test | `tests/lifecycle.test.ts` (import), every scenario test |
| Assignment reliably becomes dispatch | Implemented; automated test | `work.assign` queues in the same transaction; runner `deliver` is an idempotent bridge-surface `accept` (replay test) |
| A separate EVE runner claims and executes work | Implemented; **verified live** | `scripts/live-recovery.mjs` → `docs/evidence/live-recovery.json`: two Node 24 runner processes, real EVE, Docker deny-all, `claude-sonnet-5-5` |
| Durable attempts, leases, runner-instance evidence | Implemented; automated + live | FeltKit invocation attempts (`awaiting_approval`, `unknown`, `succeeded`) with `worker` ids; history records `instanceAuthenticated: false` |
| Observe, steer, pause, resume, interrupt, stop | Implemented; automated + browser + live | `tests/lifecycle.test.ts` (steering); `scripts/ui-check.mjs` (9/9 browser checks, screenshots in `docs/evidence/ui/`); live: signaled → received → delivered → incorporated, and the agent's diff contains the requested test |
| Approval enforced for consequential actions | Implemented; automated + live | Opening a PR requires the delegator's FeltKit invocation approval for exactly that branch and head, checked inside `runner.openPullRequest`; runner, other member, wrong digest, and different head are all refused |
| GitHub read and reconciled through FeltKit | Implemented; automated (stub); **live reads verified in Phase 0 S4** | `app.integration("github")`, `expose: false`; polling job with freshness and back-off |
| Unknown external outcomes verified before retry | Implemented; automated + live | unknown → recorded → read-verified; a retry with the same key is never re-sent |
| Runner crash recovered by another pool runner | Implemented; automated + live | lease expiry → attempt n+1 with `previous` |
| Crash after PR creation, no duplicate PR | **Implemented; automated + live** | `tests/recovery.test.ts`; live run: 1 PR, 1 create request, A exit 137, B `created:false, reconciled:true` |
| Review: accept / return / reject | Implemented; automated + live | Accept requires `verified` (the GitHub PR head equals the reported head) |
| History inspectable after recovery | Implemented; automated + live | `app.auditTrail` with `source: person/runner/system/github` |
| Desk / Work / Agents / Settings UI | Implemented; browser-checked (steering, Desk) | `src/App.tsx`, `src/AgentControl.tsx` |
| Real GitHub writes (PR creation on github.com) | **Not exercised**: forbidden by the brief (no external changes) | Writes run against a local GitHub-API stub backed by a real bare git repository |
| GitHub App installation tokens | Deferred | The credential is a FeltKit custody reference (PAT or app token supplied by the operator) |
| Per-runner identity, independent revocation | **Blocked by platform capability** | S2: a second runner principal cannot see the work (`NOT_FOUND`); one shared `runner-pool` principal is used |
| GitHub-native webhooks | Blocked by platform capability (product decision: poll) | S4: AppPort Services inbound rejects GitHub's signature format |
| EVE coding quality on realistic work | **Model/provider access resolved; quality partially proven** | S1 ran (EVE 10/10 vs Claude Code 10/10 on `claude-sonnet-5-5`), but with a ceiling effect. S1b (harder tasks) has not been run |
| Multi-workspace tenancy, usage/cost, Slack, mobile, local-laptop runners | Deferred by product decision | Discovery `IMPLEMENTATION-PLAN.md` phases 2–4 |

### About S1

The brief says S1 was never scored. It **was** scored on 2026-11-23, after the owner supplied a working Anthropic key:
- **Result:** EVE 10/10 usable and Claude Code 10/10 on the same model.
- **Evidence:** felt-ops `docs/product-discovery/phase-0/s1/evidence/`.
- **Caveat:** both harnesses solved every task in about 10 s, so S1 proves self-hosted EVE works end to end at parity on
  small, well-specified tasks. It does **not** prove quality on realistic multi-file work.
- **Release gate:** quality remains the product's highest-risk dependency, and the remaining gate is **S1b**. The free-tier
  dry runs are not used as evidence.

## Architecture

```
Person (browser) ──HTTP/SSE──▶ Handoff (FeltKit 0.3.37, Node 22, one FeltDB) ◀──MCP── Runner pool (Node 24, shared principal)
                                  │ app.integration("github") (app code only)          │ EVE (eve build/start) in Docker, deny-all
                                  ▼                                                     │ git clone/commit/push OUTSIDE the sandbox
                              GitHub (authoritative for branches, PRs, checks) ◀────────┘ (pushes only; PRs go through Handoff)
```

- **Handoff owns:**
  - delegations;
  - dispatch;
  - runner observations (claims);
  - GitHub facts (read by Handoff itself);
  - review;
  - the audit trail.
- **FeltKit owns:**
  - attempts, claims, leases, fencing, cancel and approval (invocations behind the `delegation` bridge surface);
  - steering (agent control on the runner's agent task);
  - GitHub call records, idempotency and unknown outcomes (integrations);
  - polling (jobs);
  - notifications.
- **The runner owns nothing durable.** It executes and reports.

### State transitions (`feltkit/_lib.ts`, one table)

`draft → queued → dispatched → running ⇄ awaiting_approval → reported → verified → accepted`; also `returned` (back to
`queued`, generation + 1), `rejected`, `cancelled`, `failed`.

| Transition | Function | Who | Guard |
|---|---|---|---|
| → queued | `work.assign` | person | active agent |
| → dispatched | `runner.deliver` | pool | idempotent invocation id per generation |
| → running | `runner.claim` / `runner.resume` | pool | FeltKit claim, or FeltKit approval (`NOT_APPROVED` until the delegator approves) |
| → awaiting_approval | `runner.requestApproval` | pool | current claim |
| → reported | `runner.submit` | pool | current claim. This is a claim only |
| → verified | `github.verify` / `github.syncTick` | anyone with `github.read`, or the job | GitHub PR head == reported head |
| → accepted | `work.review` | person | state `verified` |
| → cancelled | `work.cancel` / Stop | delegator only | FeltKit invocation cancel; the runner's next call gets `CLAIM_LOST` |

### Platform APIs reused (all verified against 0.3.37)

- `app.collection`, `app.auditTrail`, `ctx.db.sequence`.
- `app.surface` (bridge), `ctx.invocations.accept/start/progress/transition/resume/cancel/get`.
- `POST /api/invocations/:id/approve|reject` (person-only approval).
- Agent control: `/api/agent/tasks/:id/control[/signal|submit|withdraw|pause|resume|interrupt|stop|events]` and MCP
  `feltkit_agent_create/checkpoint/acknowledge`.
- `app.integration` with `expose: false`, `idempotencyHeader` and credential custody.
- `ctx.afterCommit.jobs.enqueue` with `runAt`; `ctx.afterCommit.notifications.send`.
- Roles; dev and test sessions; `createTestApp`; `runtime.runServices`.

## Files

| Path | What |
|---|---|
| `feltkit/app.ts` | roles, collections, audit trail, bridge surface, GitHub integration |
| `feltkit/_lib.ts` | transition table and helpers |
| `feltkit/work.ts` | person functions and read models (desk, list, detail) |
| `feltkit/runner.ts` | runner capabilities |
| `feltkit/github.ts` | approval-gated, reconcile-first PR open; observations; verification; polling job |
| `feltkit/admin.ts` | agents, repositories, settings |
| `src/App.tsx`, `src/AgentControl.tsx`, `src/styles.css` | Desk, Work, Agents, Settings; the steering controls |
| `runner/` | Node 24 runner (`src/runner.mjs`, `src/mcp.mjs`) and the EVE agent (`agent/`) |
| `tests/` | 13 tests and a GitHub-API stub (`support/github-stub.mjs`) |
| `scripts/live-recovery.mjs`, `scripts/ui-check.mjs` | live and browser evidence generators |
| `docs/evidence/` | `live-recovery.json`, `ui/` screenshots and `ui-check.json` |

## Tests and commands

| Command | Result (2026-11-23) |
|---|---|
| `npm test` (`feltkit test`) | **13/13 pass** |
| `npm run typecheck` | pass |
| `npx feltkit build` | pass (33 functions, 7 collections; reports not portable to AppBoundry because of the action and the integration) |
| `node scripts/ui-check.mjs` | **9/9 pass** |
| `RUNNER_NODE=<node24> ANTHROPIC_API_KEY=… node scripts/live-recovery.mjs` | **PASS** (fourth run; runs 1–3 found and fixed real defects, listed below) |

Each automated test runs against its own FeltDB instance and GitHub stub:
- **Recovery:** the crash-after-PR recovery scenario.
- **Approval:** absent, wrong digest, runner/other member, mismatched head.
- **Steering:** received, delivered, acknowledged; pause holds; resume.
- **Cancellation:** delegator only; runner fenced afterwards.
- **Authorization:** people vs runner; facts can't be forged.
- **Duplicates and ordering:** duplicate delivery and out-of-order or duplicate events.
- **Leases:** renewal and expiry; stale holder fenced.
- **Crash before any effect:** redo.
- **Unknown write with nothing created:** never re-sent, honest failure, return as a new generation.
- **GitHub failures:** 429 and 503 polling with back-off, then reconnect reconciles (including a merge that happened during
  the outage).
- **Reported head mismatch:** never verified.
- **Import:** an issue imported from GitHub.
- **Polling job:** the job queued at submit verifies on its own.

**Mutation check:** with reconcile-before-create disabled, the recovery test fails. The test proves the behaviour.

### Defects found by the live runs and fixed

1. **Runner/EVE runtime.** Under Node 24 the runner's EVE CLI still resolved Node 22 from `PATH`, and EVE build failed.
   - The runner now puts its own Node first on `PATH`.
2. **Crash loop.** A deterministic execution error was abandoned to lease expiry, which made the pool re-claim forever
   (attempts 1–5 `unknown`).
   - The runner now reports `runner.fail`.
3. **Admin could not read GitHub.** The `admin` role lacked `github.read`, so polling as an admin failed.
4. **The verification job never ran, silently.** The runner role lacked `jobs.create`/`jobs.execute`, and FeltKit
   reported nothing to the app (see the platform list).
   - Fixed, with a regression test.

### Combined recovery scenario: live evidence (`docs/evidence/live-recovery.json`)

1. **Runner A** (real EVE) fixed `formatMoney` and pushed `handoff/d1-g1`.
2. **Ada steered** mid-run: signal, then submit into the same instruction. The update was delivered and incorporated, and
   the commit includes the requested "−5 cents" test.
3. **Approval.** A asked to open a PR for that head, and Ada approved through FeltKit.
4. **A opened the PR.** GitHub created it, then the connection dropped. Handoff recorded `github.write.unknown`, verified
   by reading (`github.pr.observed`), and A exited 137 before reporting.
5. **The state stayed honest:** `running`, no report.
6. **Lease expiry.** After 20 s, runner B claimed attempt 3. The invocation shows `awaiting_approval`, `unknown`, then
   `succeeded`.
7. **Runner B reconciled:**
   - remote branch head reused;
   - PR #1 found: `created: false, reconciled: true`;
   - **one PR, one create request**;
   - reported.
8. **The job verified** the PR head against the report, and Ada accepted.

## Security and authority limitations

- **One trusted runner pool per deployment.** Every runner holds the same `runner-pool` session, so the pool is equally
  trusted. Revoking that session stops all of them; individual runners can't be attributed or revoked. Instance ids
  are recorded as asserted only.
- **The runner role may call `github.observe`/`github.verify`.** These take no fact arguments and re-read GitHub, so a
  runner can make Handoff look but can't write a fact. FeltKit has no internal-only functions, so this is a design rule,
  not a platform guarantee.
- **Cancel and Stop are cooperative.** They take effect at the runner's next FeltKit call (about 1.5 s in the runner
  loop). EVE can't pause mid-step; interrupt cancels the current model step through EVE's session cancel.
- **The steering acknowledgement is the runner's.** It confirms the update was delivered to the EVE session, not that
  the model followed it. The model's own explanation is in the run's messages.
- **Credentials:**
  - The GitHub credential is a FeltKit custody reference.
  - The model key and git credentials live only in the runner's environment.
  - The sandbox has no network and no credentials; git runs in the runner.
  - Evidence and records were scanned for secrets.
- **One deployment is one workspace.** Multi-tenant pools are out of scope.

## Operational limitations

- Scripts and tests use FeltKit **development** sessions. Production needs operator-issued sessions
  (`feltkit session create --type service` in production) and a real GitHub credential.
- **EVE rebuilds the agent per attempt.** The repository is a build-time workspace seed, which costs about 10–20 s per
  attempt.
- **Container attribution is by name prefix.** The runner picks out its sandbox by `eve-sbx-*` name and creation order.
  It refuses to proceed unless exactly one new container appears, so one EVE execution per runner host at a time.
- Polling interval: 30 s by default, with back-off up to 15 min (`HANDOFF_POLL_MS`).

## Before a real pilot

1. **S1b:** a harder, pre-registered EVE quality run on a real repository.
2. **A real GitHub App:** installation-scoped tokens, a default-branch protection check at repository connect, and live
   PR writes against a sandbox organization, with the owner's authorization.
3. **Production deployment:** sessions, credential vault, backup. Run the live scenario against a `feltkit start`
   build.
4. **Per-runner identity** (platform E-1) before any multi-team or untrusted runner pool.
5. **A UI review** with a real delegator. Only the steering surface and the Desk were browser-checked.

---

## Platform list: what is missing, and what had to be worked around

### FeltKit 0.3.37

1. **No per-runner identity on invocations (missing, E-1).** An invocation is visible only to its person and its
   deliverer.
   - *Workaround:* one shared `runner-pool` principal; instance ids recorded as asserted.
2. **Actions can't be AppPort capabilities (constraint).**
   - *Workaround:* `runner.openPullRequest` is a mutation that performs network I/O inside a transaction. It is safe only
     because it reconciles with GitHub before creating, and because of the idempotency key.
3. **No internal (non-capability) functions (missing).** Any helper mutation an action would call is callable by
   sessions with its permission.
   - *Workaround:* fact-recording functions take no fact arguments and re-read GitHub.
4. **Failed after-commit job enqueue is invisible to the app (defect; felt-ops F-036 still open).** A missing
   `jobs.create` permission made `ctx.afterCommit.jobs.enqueue` fail after commit, while the mutation succeeded and no
   activity was recorded.
   - *Workaround:* grant `jobs.create` and `jobs.execute`, plus a regression test.
5. **Invocation and agent-control state is outside the live-query change feed (limit).**
   - *Workaround:* Handoff mirrors state into its own `delegations` collection. Steering uses the control SSE stream,
     which re-reads every second.
6. **Approval of agent-owned AgentHost actions is Studio-only (G-07 remainder).**
   - *Workaround:* use **invocation** approval (`awaiting_approval`, person-only, digest-bound) for "open PR", checked
     in app code at the execution boundary.
7. **No React components or hooks for agent control or invocation approval (missing).** The client has no public
   methods for them, and private `#post` handles CSRF.
   - *Workaround:* the app fetches `/api/session` for the CSRF token and calls the HTTP routes itself
     (`src/AgentControl.tsx`).
8. **Integration verify is available only on Studio/admin routes, not on `ctx` (missing).**
   - *Workaround:* the app verifies unknown writes by its own observation read.
9. **Lifecycle moves commit separately from the mutation's own writes (documented limit).** A crash between them can
   leave app records behind the invocation.
   - *Mitigation:* the next claim or status read reconciles. Not fully closed.
10. **No agent loop runner (documented).** The runner is application-side code.
11. **Not portable to AppBoundry:** actions and integrations (reported by `feltkit build`).
12. **The CHANGELOG labels lag the published packages.** For example, agent control is listed as "Unreleased" though it
    ships in 0.3.36/0.3.37. Verifying the tarballs was necessary.
13. **Minor:**
    - Capability and operation names must be lowercase.
    - An app with no collections can't start.
    - `createTestApp` runs services only when asked (`runServices`).
    - A person's token works over MCP (relevant to GAP-12).

### FeltDB 0.22 (through FeltKit)

1. **No paused execution status (documented).** FeltKit keeps the mode in its own control record. No app impact
   beyond that.
2. **Agent state is not in the change feed.** That is the cause of FeltKit item 5.
3. **The Intent engine isn't wired, and `record_intent` isn't exposed to TypeScript.** It isn't usable for workflow
   (discovery finding, unchanged).
4. No direct FeltDB defects were hit by application code. Uniques, indexes, sequences, the audit trail and
   transactions behaved as documented.

### AppPort (core 1.11, sdk 1.11, via FeltKit 0.3.37)

1. **The idempotency refusal for an unknown prior call is an AppPort error, not a FeltKit error.** The code is
   `CONFLICT` with reason `IDEMPOTENCY_OUTCOME_UNKNOWN`. Rethrown from a mutation it surfaces as `INTERNAL`.
   - *Workaround:* detect it by shape (`code`, `details.reason`, message).
2. **The capability contract excludes actions.** That is the cause of FeltKit item 2.
3. **`appport.agent.changed@1` is not emitted (documented).** Clients read control state over FeltKit's SSE.
4. **Direct MCP calls are not linked to an agent task (G-07 remainder).** Handoff links its own records by delegation
   id instead.

### AppPort Services 0.20

1. **Inbound webhooks accept only the AppPort signature scheme (missing for GitHub, E-4).**
   - *Workaround:* polling via jobs.
2. **Job enqueue requires `jobs.create` and execution requires `jobs.execute`; refusal after commit is silent.** See
   FeltKit item 4.
3. **`jobs.enqueue` takes no idempotency key or dedupe (documented).**
   - *Workaround:* the polling chain carries a `chain` token checked against the `sync` record, so stale chains do
     nothing.
4. **Scheduled jobs carry no workspace (documented).** No impact in v1, which has a single workspace.

### EVE (`@appport/eve` 1.0.2)

1. **`eve init` scaffolds upstream `eve`, not the fork.**
   - *Workaround:* `"eve": "npm:@appport/eve@1.0.2"`.
2. **Requires Node ≥ 24** (the scaffold writes `26.x`). FeltKit runs on Node 22.
   - *Workaround:* a separate runner runtime, and the runner prepends its own Node to `PATH` for EVE's CLI (live defect
     1).
3. **`eve dev`'s credential broker refuses a valid direct Anthropic key** ("model connection unavailable").
   - *Workaround:* `eve build` + `eve start`.
4. **No operator pause; interrupt only via session cancel.**
   - *Workaround:* the runner enforces pause between turns and sends "continue" on resume after an interrupt.
5. **No structured result** (branch, commit, files changed).
   - *Workaround:* the runner `docker cp`s `/workspace` out and commits and pushes outside the sandbox.
   - Container attribution is by name prefix; this caused void run V1 in Phase 0.
6. **The workspace is a build-time seed.** One rebuild per attempt.
7. **Docker network policy is only allow-all or deny-all, with no credential brokering off Vercel.**
   - *Workaround:* deny-all, with git done in the runner.
8. **The event stream ends every ~60 s (lease).**
   - *Workaround:* bounded catch-up reads by index.
9. **String model ids route through the Vercel AI Gateway.** The key provided in this session was free tier and
   refused Anthropic models.
   - *Workaround:* direct provider through `anthropic()`.
10. **No published AppPort work channel (E-3).**
    - *Workaround:* `runner/src/runner.mjs`, about 280 lines.
11. **Carried from discovery and unchanged:**
    - The fork's CI has never run on a PR.
    - Upgrades strand in-flight sessions.
    - Multi-replica operation is unverified.
