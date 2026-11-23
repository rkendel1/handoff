# T3 product reference: final report

**Scope.** T3 Code was used as a product reference for Handoff's web experience. It was not modified or ported.

**State.** Branch `claude/wonderful-wright-rgzwsf`. Platform versions: FeltKit 0.3.37 (exact), EVE `@appport/eve` 1.0.2.

**Companion documents:**
- [T3-REFERENCE-MAP.md](T3-REFERENCE-MAP.md): every capability with its classification and home.
- [PRODUCT-IMPLEMENTATION-PLAN.md](PRODUCT-IMPLEMENTATION-PLAN.md): what was built and the order of what comes next.
- [PLATFORM-GAPS.md](PLATFORM-GAPS.md): new or newly evidenced platform gaps.
- [t3-evidence/](t3-evidence/): per-capability audits A–D, plus screenshots of T3 running.

## What was run, and what it showed

| Check | Result | Evidence |
| --- | --- | --- |
| `npx tsc --noEmit` | clean | — |
| `npm test` (FeltKit test app plus GitHub stub) | **23/23 pass**: 13 from v1 (unchanged and passing) and 10 new product tests | `tests/lifecycle.test.ts`, `tests/recovery.test.ts`, `tests/product.test.ts` |
| `node scripts/ui-check.mjs` (real dev server, Chromium) | **19/19 pass**: the 9 v1 steering checks plus Desk, timeline layers and trust, attempt hierarchy, capability-gated controls, approval in the UI, source control, Agents, Settings | `docs/evidence/ui/ui-check.json`, `01`–`11*.png` |
| `node scripts/session-probe.mjs` (real dev server) | **5/5 pass**: per-runner sessions observed and revoked one at a time | `docs/evidence/session-probe.json` |
| `scripts/live-recovery.mjs` (two real runner processes, real EVE in Docker, real model) | **PASS**. A crashed (137) right after creating the PR; B took over after the lease expired. One PR from one create request, verified, accepted. Steering went signaled → received → delivered → incorporated. New this phase: 4 tool-call starts with `callId`, 5 usage reports (45,448 tokens in, 962 out, no cost reported), session refs on attempts, no secrets in the evidence | `docs/evidence/live-recovery.json` |
| `npm run build` | passes. As in v1, it notes that actions and integrations are not portable to AppBoundry | — |

GitHub was a local GitHub-API stub, backed by a real bare git repository for the live run. No real GitHub writes
were authorized. Nothing was deployed or published.

## Outcomes by classification

### Implemented and verified

Each item is covered by an automated or browser test, and by the live run where marked.

- **Desk:** attention groups with reasons, framed for whoever is signed in (yours, or waiting for someone else).
- **Work:**
  - lifecycle stepper;
  - approval card showing what is approved and what isn't;
  - attempts → EVE sessions → turns, with how each attempt started (started, took over, resumed after approval) and
    the previous attempt's outcome;
  - layered timeline with trust labels (decided, reported, observed, verified, asserted, system) and layer filters.
- **Source control (observed):**
  - PR and state, check runs, reviews, commits, changed files with patches;
  - recorded only when it changes;
  - a PR closed without merge is never verified or accepted. This was a defect found during mapping.
- **Runtime capabilities:** declared by the runner and normalized (unknown → none). Unsupported controls are disabled
  with a reason.
- **Agents:** runners with state, runtime, current work, staleness, capabilities, observed session ref, and the
  session-ended state.
- **Settings:** connection checks recorded per repository; execution policy (bounded, people only, with
  provenance); approval rules; credential references; capability vocabulary.
- **Policy:** `maxAttempts` and lease bounds enforced at the claim boundary.
- **Per-runner attribution and revocation through FeltKit sessions.** Verified live. This is not per-runner identity
  (see "Blocked by platform").
- **Activity:** in-progress tool calls (EVE `call.started` with `callId`) and usage with provenance. Cost appears only
  when the provider reported it. Live-verified with real EVE.
- **Credential-shaped runner text is masked when Handoff accepts it:** events, summaries, failures, heartbeat errors.
- **Approval decision read-back:** a decision taken in the UI refreshes open views, with the approver taken from
  FeltKit's record.
- **Preserved from v1:** all 13 v1 tests, the 9 steering browser checks, and the live crash-after-PR recovery.

### Partially implemented

- **Source control.** Missing:
  - commit statuses (only check runs are read);
  - required-check flags;
  - review staleness against the head;
  - mergeability;
  - per-generation diff and a file tree.
- **Failure presentation.** There is a code, a message, `effect` and ATTEMPTS_EXHAUSTED, but no failure class or
  retryable hint.
- **Turn presentation.** Attempts fold, but finished turns have no duration or tool-count summary.
- **Rejection reason.** It is recorded by FeltKit and readable by the runner, but not sent to the EVE session.
- **PR watch.** Polling verifies and refreshes, but never wakes the agent.

### Blocked by platform

Each item has a repro and a proposed contract in PLATFORM-GAPS.md.

- **PG-1 (FeltKit):** approval decisions are outside the live-query feed. Worked around inside Handoff; a decision
  taken elsewhere still isn't reflected until Handoff's next write.
- **PG-2 (FeltKit):** per-runner *principals* on invocations. Visibility and claims are per principal, and teammates
  cannot see invocation attempts or approval.
- **PG-3 (FeltKit agent control):** no server-side refusal of operations the runtime can't perform. The Handoff UI
  gates them, but the HTTP routes still accept them.
- **PG-4 (FeltKit agent control):** no acknowledgement deadline for stop or interrupt.
- **PG-5 (FeltKit live queries):** no time-based re-evaluation. The Desk's staleness is refreshed incidentally by the
  polling job's writes.
- **Unchanged from v1:** GitHub webhooks (AppPort Services, E-4); actions are not capabilities; no internal functions.

### Deferred, with reasons

- **Live command-output tail.** It needs a transient channel and must not become evidence.
- **Queue edit and reorder.** Low value for delegation.
- **Autonomy modes and ceiling.** Only one gated action exists today.
- **Sub-delegation and child approvals.** No sub-delegation in v1.
- **Merging from Handoff.** People merge on GitHub.
- **Command palette, agent-requested secrets, push and mobile, cross-delegation cost aggregation.**

### Not applicable

- **Local-first mechanisms:** worktrees, checkpoints and rewind, local commit and push, terminals, Tailscale, SSH
  and relay, pairing codes, device approval, provider account limits, transcript-file cost scanning.
- **Not adopted because they conflict with Handoff's evidence model:** history pruning, automatic re-send after a
  restart, failure inferred from output text, agent statements treated as observed state.

## Custom versus platform code

**This phase's diff against v1 (`537b090..HEAD`, application code only):**

| Area | Change |
| --- | --- |
| Handoff backend `feltkit/` | +384 / −33 |
| Web `src/` | +519 / −212 (old single-file UI replaced by modules) |
| Tests | +284 |
| Runner and scripts | the remainder of the +1,359 total |

**Everything that is platform, reused rather than rebuilt:**
- **FeltKit:** invocations (claims, leases, fencing, attempts, approval), agent control (signal, submit,
  checkpoint, acknowledge, pause, interrupt, stop, SSE), sessions and `ctx.auth.session.ref`, `auth.onSessionEnd`,
  the audit trail, collections and live queries, jobs, the integration with credential custody and idempotency keys,
  notifications.
- **EVE:** sessions, turns, call and usage facts, the Docker sandbox.
- **GitHub:** source-control truth.

**Handoff added no queue, identity system, approval engine, event bus, secret store or registry of its own.**
Its new state is limited to three things:
- `workers`: self-reported runner heartbeats, plus the observed session ref;
- `policy`: one record;
- optional fields on existing records: a runtime mirror on delegations, and `callId` and `usage` on run events.

## Honest limits of this report

- **The T3 running capture was limited by what runs without provider accounts.** The screenshots show onboarding,
  projects, the model picker, approval, steering, interrupt, the inline diff and the command palette. Claims about
  T3 behavior beyond those rest on code reading (file:line in A–D).
- **The UI check drives runner calls directly over MCP**, without EVE. Only the live run exercises real EVE.
- **"Carry-forward of steering across attempts" holds by design** (the agent task is reused) and is not separately
  tested.
- **Desk staleness depends on the GitHub polling job's writes** (PG-5).
