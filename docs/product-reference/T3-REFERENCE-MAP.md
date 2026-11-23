# T3 → Handoff reference map

T3 Code (`rkendel1/t3code` at `fab237d6`) was used as a **product and interaction reference**, not a source to port.
T3 is a local-first agent workbench: one person, one machine, the person's own credentials, the execution
environment *is* the product. Handoff is a delegation system: people hand work to agents, Handoff owns the
delegation record, FeltKit owns the lifecycle machinery, GitHub owns source-control truth, EVE executes.
Each T3 capability was asked the same question: *what user problem does this solve, and where does that
solution belong on our stack?*

**Evidence.** Per-capability detail is in `t3-evidence/`. Each capability there records the user problem, the action
and state transition, what is visible before, during and after, what is durable and what is transient, failure
handling, what can be retried, authority, the T3-local aspects, and whether Handoff supports it. Facts are cited by
file and line; judgments are marked.

| File | Scope |
| --- | --- |
| [A-threads-activity.md](t3-evidence/A-threads-activity.md) | threads, turns, attempts, activity, tools, failure, usage |
| [B-providers-approvals-steering.md](t3-evidence/B-providers-approvals-steering.md) | capability declaration, approvals, steering, interrupt, agent-to-agent, MCP, terminals |
| [C-workspace-source-control.md](t3-evidence/C-workspace-source-control.md) | projects, worktrees, checkpoints, diffs, PRs, checks, reviews, scheduling |
| [D-remote-auth-secrets-clients.md](t3-evidence/D-remote-auth-secrets-clients.md) | pairing, scoped sessions, presence, revocation, reconnect, secrets, clients |
| [running/](t3-evidence/running/) | T3 run locally: screenshots of first run, projects, the model picker, approval, steering, interrupt, inline diff, and the command palette |

**Classifications** (as the brief defines them):

| Classification | Meaning |
| --- | --- |
| Already implemented | Handoff did this before this phase |
| Implemented (this phase) | Built in this phase; it still counts as implemented, and the label shows when it was built |
| Implemented but incomplete | Part of it exists; the gap is named |
| Missing | Belongs in Handoff and isn't built |
| Not applicable | Exists in T3 only because T3 is local-first |
| Platform dependency | Belongs in, or is blocked on, a platform repo; listed in [PLATFORM-GAPS.md](PLATFORM-GAPS.md) |
| Deferred | Belongs in Handoff but is out of scope now, with the reason |

## 1. The model: how work is structured

| # | T3 capability | T3 behavior (evidence) | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Thread → run → attempt → turn | Attempts are typed (`initial`, `steering_restart`, `retry`, `provider_recovery`, `superseded`) and kept (A §0, §2) | Delegation → generation (FeltKit invocation) → attempt (claim) → EVE session → turn → activity. Each attempt shows how it started (started, took over, resumed after approval) and the previous attempt's outcome | Implemented (this phase): `work.timeline` attempt hierarchy, Execution panel | Handoff over FeltKit invocations |
| 1.2 | Durable history across attempts | Append-only event log plus projections; old attempts superseded, not deleted (A §0) | FeltDB audit trail per delegation, runEvents keyed `(attempt, seq)`, and invocation attempt history | Already implemented; the UI now shows it (this phase) | Handoff (FeltDB audit trail) |
| 1.3 | History pruning | T3 can prune the event log (A §10) | Not done. A delegation's history is its evidence | Not applicable (deliberately not adopted) | — |
| 1.4 | Idempotent commands | Handled-command records (A §0) | FeltKit invocation idempotency, `(attempt, seq)` dedupe, the PR idempotency key | Already implemented | FeltKit |

## 2. Activity: what the agent is doing

| # | T3 capability | T3 behavior | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Typed transcript items | Messages, reasoning, file changes, commands with exit codes, plans, todos, approvals, checkpoints (A §3) | Runner events: progress, tool, command, test, message, warning, error, usage, with session, turn, status and callId | Implemented but incomplete: no plan or todo items | Runner and Handoff schema |
| 2.2 | Tool lifecycle: start, then settle | Call items with ids, running state, live output (A §4) | The runner now carries EVE `call.started`; start and settle are linked by `callId`, and open calls are listed per attempt | Implemented (this phase). Live output tail: Deferred | Runner and Handoff; EVE already emits it |
| 2.3 | Live command output | 50 ms batched live updates, not persisted (A §0) | None | Deferred: needs a transient channel; FeltKit agent-control SSE is the candidate | FeltKit transport plus a Handoff view |
| 2.4 | Turn and attempt folding | Finished turns collapse to "Worked for 4m"; superseded attempts folded; failures stay expanded (A §9) | Attempts are collapsible; events open per attempt; the timeline filters by layer | Implemented but incomplete: no per-turn duration summary | Handoff UI |
| 2.5 | Provenance of statements | T3 treats agent statements as observed state (A §10) | Every entry is labelled reported, observed, verified, decided, system or asserted | Implemented (this phase). Handoff is deliberately stricter than T3 | Handoff |
| 2.6 | Tool failure inference | T3 pattern-matches output text (A §10) | Failure comes from the exit code and settlement outcome only | Already implemented; T3's approach not adopted | Runner |
| 2.7 | Unknown event kinds | Skipped, not fatal (A §9) | The runner ignores EVE fact types it doesn't map | Already implemented | Runner |

## 3. Failure, recovery and uncertainty

| # | T3 capability | T3 behavior | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Structured failure | class, code, retryable, resetAt, retry counter (A §6) | `failure {code, message}`, `effect: none or possible`, ATTEMPTS_EXHAUSTED; unknown external writes are recorded as `unknown_write` facts | Implemented but incomplete: no failure class or retryable hint shown | Runner and Handoff schema |
| 3.2 | Bounded retries | Provider retries "(2/5)" (A §6) | Execution policy `maxAttempts`, enforced at claim; lease bounds | Implemented (this phase): Settings policy editor and claim boundary, tested | Handoff policy over FeltKit claims |
| 3.3 | Recovery after a crash | Restart cancels unfinished runs with a notice (A §6) | FeltKit lease expiry → re-claim marks the previous attempt unknown → `attempt.takeover`; the PR is reconciled, never duplicated | Already implemented (live-verified in v1) | FeltKit and Handoff |
| 3.4 | Stale or not-responding indicator | "Agent not responding to Stop" plus Force stop (B §6) | Desk "Failed or uncertain" when no runner report arrives for 2 minutes; Agents marks a runner stale after 45 s without a heartbeat | Implemented (this phase). Stop-acknowledgement deadline: Platform dependency (PG-4) | Handoff; FeltKit agent control |
| 3.5 | Auto re-send after restart | T3 re-sends the prompt (A §10) | Never automatic after a possibly effectful failure; a person returns the work | Not applicable (deliberately not adopted) | — |
| 3.6 | Sync or disconnect indicator | "Syncing / Could not sync" (A §8) | "Live / Connecting" in the top bar; GitHub last read and last error on Desk and Settings | Already implemented | Handoff over FeltKit live queries |

## 4. Steering, approvals, runtime capabilities

| # | T3 capability | T3 behavior | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Declared runtime capabilities | 12-group struct per session, server-routed, with unsupported refusals (B §1) | Six declared controls (steer, pause, interrupt, resume, stop, reconnect), normalized (unknown → none), shown on Agents and the work page; unsupported controls disabled with a reason | Implemented (this phase). Server-side refusal: Platform dependency (PG-3) | Handoff UI; FeltKit agent control |
| 4.2 | Steer mid-turn, queue | Steer, restart or queue; a steer that misses carries forward (B §5) | FeltKit agent control: signal ("update coming"), submit, delivered at the next checkpoint, acknowledged. Pause between steps. Interrupt | Already implemented (v1), now capability-aware. Carry-forward across attempts holds by design: a takeover attempt reuses the generation's agent task (`runner.mjs:100`), so pending instructions reach its first checkpoint. Not separately tested | FeltKit agent control |
| 4.3 | Queue edit, reorder, promote | Yes (B §5) | Withdraw only | Deferred: low value for delegation; FeltKit instructions would need it | FeltKit, then Handoff UI |
| 4.4 | Approval request lifecycle | Record the decision, then deliver it; delivery-unconfirmed state (B §3) | FeltKit invocation approval: person-only, digest-bound, expiring. Handoff checks it again at `openPullRequest`. The decision is read back into Handoff history so open views update | Implemented: approval in v1; read-back this phase (PG-1 workaround) | FeltKit and Handoff |
| 4.5 | Named approver and digest | No: any operator, no timeout (B §4) | Yes | Already implemented; Handoff is stronger than T3 | FeltKit |
| 4.6 | "Why am I asked?" | Popover (B §4) | Settings → Approval rules lists action, rule, approver and where it is enforced; the approval card says what approving does and doesn't do | Implemented (this phase) | Handoff |
| 4.7 | Decline with feedback to the agent | Live approvals only (B §3) | The rejection reason is recorded by FeltKit and visible to the runner's snapshot | Implemented but incomplete: not sent to the EVE session | Runner |
| 4.8 | Permission or autonomy modes with a ceiling | 4 modes plus an admin ceiling (B §2) | One gated action (open PR) | Deferred until more consequential actions exist | Handoff product; AuthBoundry ceiling |
| 4.9 | Agent-to-agent, child approvals roll up | Yes (B §9) | Not built | Deferred: no sub-delegation in v1 | Handoff; AuthBoundry caps |
| 4.10 | Terminals, MCP connections | PTY, ACP terminals, MCP credentials (B §10–11) | — | Not applicable | — |

## 5. Source control

| # | T3 capability | T3 behavior | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 5.1 | Git and GitHub authoritative, dated snapshots | Cached reads; the thread stores a link plus `observedAt` (C §9) | Facts with `observedAt`, read by Handoff with its own credential; nothing taken from the runner | Already implemented | Handoff (GitHub integration) |
| 5.2 | Diff review | File tree and code view; per-turn, branch, uncommitted and commit scopes (C §4) | Changed files with +/− counts and patches (capped, truncation shown); base and head SHAs; commits | Implemented (this phase). Per-generation diff and file tree: Missing | Handoff |
| 5.3 | PR, checks, reviews | GraphQL rollup: checks plus statuses, required flags, review staleness (C §7) | PR state, check runs (passing, failing, pending), reviews (approved, changes requested), labelled observed | Implemented (this phase). Commit statuses, required flags, review staleness against head, mergeability: Missing | Handoff |
| 5.4 | Open a PR safely | Reconcile open PRs, then a plain POST; no idempotency key (C §6) | Approval for the exact head, reconcile, idempotency key, unknown outcome verified by reading GitHub | Already implemented; Handoff is stronger than T3 | Handoff |
| 5.5 | Closed-PR handling | Adopts only open PRs (C §6) | One PR per generation is kept. A PR closed without merge is never verified or accepted (fixed this phase); a new generation gets a new branch | Implemented (this phase) | Handoff |
| 5.6 | Merge pinned to head | `expectedHeadSha` (C §7) | Handoff doesn't merge | Deferred: merging stays with people on GitHub | Handoff, if ever |
| 5.7 | PR watch that wakes the agent | Re-read every 2 minutes; wake on checks or reviews (C §7) | Polling job verifies and refreshes | Implemented but incomplete: no agent wake-up | Handoff plus FeltKit jobs and agent control |
| 5.8 | Worktrees, checkpoints, rewind, local commit and push | Local (C §2, §3, §5) | EVE sandbox, one branch per generation, the runner commits and pushes | Not applicable | — |
| 5.9 | GitHub webhooks | — | Polling | Platform dependency (existing E-4) | AppPort Services |

## 6. Remote operation, identity, secrets

| # | T3 capability | T3 behavior | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 6.1 | See who is connected | Live socket presence; connected-for and last-connected (D §3) | Agents: runners with state, runtime, current work, last heard, staleness; labelled asserted | Implemented (this phase) | Handoff |
| 6.2 | Revoke one client, with live cut-off | Per session or device key (D §4) | **Verified on 0.3.37:** each runner can hold its own `runner-pool` session. Handoff records the session ref it observes, `feltkit session revoke` stops that runner alone, and `auth.onSessionEnd` marks it on Agents (`scripts/session-probe.mjs`, `docs/evidence/session-probe.json`) | Implemented (this phase). Per-runner *principal* (invocation visibility): Platform dependency (E-1, PG-2) | FeltKit sessions; Handoff display |
| 6.3 | Pairing codes, DPoP, device approval | (D §1, §5, §6) | Operator-issued tokens | Not applicable now; FeltKit or AuthBoundry if ever needed | FeltKit |
| 6.4 | Reconnect: transient vs blocked | One retry owner (D §8) | The runner exits on UNAUTHORIZED (exit 3) and retries network failures; the UI shows Live or Connecting | Already implemented | Runner |
| 6.5 | Resume from a cursor, never auto-replay mutations | (D §9) | `(attempt, seq)` dedupe; stream read by index; mutations not replayed | Already implemented | Runner and FeltKit |
| 6.6 | Secrets out of clients and logs | Secret store, redaction (D §11) | GitHub credential by reference only (never in records; tested). Credential-shaped runner text is now masked when Handoff accepts it: events, summaries, failures, heartbeat errors | Implemented (this phase) | Handoff boundary; FeltKit custody |
| 6.7 | Agent-requested secrets | Private card, single-use reference (D §11c) | — | Deferred | FeltKit or AppPort Services |
| 6.8 | Tailscale, SSH, relay | (D §10) | — | Not applicable | — |
| 6.9 | Mobile and push | Push phases including stale; tap opens the thread (D §12) | FeltKit notifications service (in-app) | Deferred | AppPort Services |

## 7. Usage and cost

| # | T3 capability | T3 behavior | Handoff | Classification | Home |
| --- | --- | --- | --- | --- | --- |
| 7.1 | Per-turn usage | Stored; context-window meter (A §7) | The runner carries EVE `usage.recorded`; per-attempt token totals | Implemented (this phase) | Runner and Handoff; EVE emits it |
| 7.2 | Cost with provenance | Reported, priced or unpriced; "API estimate" (A §7) | Cost shown only when the provider reported it; otherwise "cost not reported"; partial coverage is stated | Implemented (this phase). No price table, by choice | Handoff display; aggregation across delegations: Deferred |
| 7.3 | Account usage limits | Provider account (A §7) | — | Not applicable | — |

## 8. Navigation and product areas

| T3 | Handoff area | What it answers |
| --- | --- | --- |
| Sidebar threads with "needs you" badges | **Desk** | What needs me, and why: approval, paused or interrupted, failed or uncertain, review, assignment, active, accepted |
| Thread view | **Work → item** | The request, lifecycle stepper, approval, steering, execution (attempts, sessions, turns, open calls, usage), source control, result and review, layered timeline |
| Thread list | **Work** | Every delegation; new work; import a GitHub issue |
| Provider and connection settings | **Agents** | Agent definitions; runners with runtime, capabilities, session and staleness |
| Settings | **Settings** | Repositories and connection checks, GitHub sync, execution policy, approval rules, credential references, capability vocabulary, runner identity |
| Command palette, keybindings, themes | — | Theme toggle exists. The command palette is Deferred |
