# Platform gaps: new or newly evidenced in the T3 reference phase

This lists only what this phase found or newly evidenced. The existing registers remain authoritative and are not
repeated here:

- Handoff v1: [docs/IMPLEMENTATION-REPORT.md → "Platform list"](../IMPLEMENTATION-REPORT.md#platform-list-what-is-missing-and-what-had-to-be-worked-around)
- felt-ops discovery: `docs/product-discovery/FELTKIT-BASELINE.md` and `phase-0/` (rkendel1/felt-ops)
- FeltKit's own register: `docs/platform/GAP-REGISTER.md` (FeltKit repo) and `UPSTREAM-GAPS.md` in the published package

Per the brief, each gap was classified before any local workaround was written. Every workaround here stays inside
Handoff's own boundary. None duplicates a platform mechanism.

## PG-1 · FeltKit: an invocation's approval decision never reaches live queries (newly evidenced)

- **Owner:** FeltKit (invocations and the live-query change feed).
- **Relation:** a concrete, user-visible consequence of register item FeltKit-5 ("invocation state is outside the
  change feed").
- **Repro:**
  1. A delegation reaches `awaiting_approval`.
  2. Its delegator approves through `POST /api/invocations/:id/approve`, the platform route.
  3. Every open `work:detail` subscription keeps rendering "Approval needed", because no FeltDB record that a query
     reads has changed.
  4. This was seen in the browser check (`scripts/ui-check.mjs`) before the workaround.
- **Workaround (Handoff):**
  - After FeltKit accepts the decision, the UI calls `work:recordApprovalDecision`.
  - That mutation takes no decision input. It reads `approval.decision` or `approval.rejection` from FeltKit and
    records `approval.decided` in Handoff's history, once per digest. That write refreshes live queries.
  - Tested in `tests/product.test.ts` (approval-decision test).
  - **Residual:** a decision taken anywhere else (Studio, another client) still isn't reflected until the next
    Handoff write.
- **Proposed contract, either of:**
  - (a) Invocation state changes are signals in the change feed, so queries that call `ctx.invocations.get`
    re-evaluate.
  - (b) An app hook declared like `auth.onSessionEnd`, for example
    `invocations: { onApprovalDecided: "<module:fn>" }`, run with `{ invocationId, decision }` in the transaction
    that records the decision.

## PG-2 · FeltKit: per-runner *sessions* work; per-runner *principals* on invocations don't (E-1, re-scoped)

- **Owner:** FeltKit (invocations, sessions). AuthBoundry local agents are the likely principal source.
- **New evidence:** `scripts/session-probe.mjs`, with results in `docs/evidence/session-probe.json`, run against a
  real dev server on 0.3.37:
  - Two `runner-pool` sessions coexist.
  - `ctx.auth.session.ref` gives each a distinct, server-observed ref.
  - `feltkit session revoke <ref>` refuses the next call from that runner only (UNAUTHORIZED) while the other runner
    keeps working.
  - `auth.onSessionEnd` fires with `reason: "revoked"`.
- **What this closes:** per-runner **attribution** and **revocation**. Handoff now records the session ref on
  heartbeats and claims and shows it on Agents. Register item FeltKit-1 ("cannot attribute or revoke individually")
  is out of date on that point.
- **What remains:**
  - Every session is the same principal. Each runner can see and claim every pool invocation, and roles cannot
    differ per runner (for example, per repository).
  - FeltKit's attempt record names the worker by the app-supplied `worker` string, not the session.
  - Visibility stays limited to the person and the deliverer: a teammate cannot see an invocation's attempts or
    approval.
    - Handoff shows teammates its mirrored records instead.
    - `recordApprovalDecision` is refused with NOT_FOUND for anyone but the delegator; tested.
- **Proposed contract:**
  - `ctx.invocations.start` records `worker.session` (the caller's session ref) on the attempt.
  - Invocation visibility can be granted to a declared role. This is read-only for teammates and has no effect on
    claims.
  - A deliverer can be an AuthBoundry local agent, so a runner gets its own principal and grants.

## PG-3 · FeltKit agent control: tasks don't declare what the runtime can honor (new)

- **Owner:** FeltKit (agent control).
- **Repro:**
  1. Create an agent task for a runtime that cannot pause mid-step or be interrupted.
  2. A person calls `/control/pause` or `/control/interrupt`.
  3. FeltKit accepts and records the mode change. The agent cannot honor it, and nothing tells the person.
  4. T3, by contrast, refuses unsupported operations with a typed error naming the capability (evidence B §1).
- **Workaround (Handoff):**
  - Runners declare capabilities on heartbeat and report; values are normalized and unknown values become `none`.
  - The UI disables unsupported controls and says why (browser check: "controls the runtime declares 'none' are
    disabled with the reason").
  - This is presentation only. The HTTP routes still accept the operation.
- **Proposed contract:**
  - `createTask({ capabilities: { pause, interrupt, steer, resume, stop } })`.
  - Control routes refuse an undeclared operation with `UNSUPPORTED_BY_RUNTIME`.
  - Capabilities are included in the `control` SSE state.

## PG-4 · FeltKit agent control: no acknowledgement deadline for stop or interrupt (new)

- **Owner:** FeltKit (agent control).
- **Problem:**
  - A stop or interrupt is recorded and then waits for the agent's next checkpoint, with no deadline.
  - A wedged agent looks identical to a busy one.
  - T3 shows "Agent not responding to Stop" after 2 s and offers a forced stop (B §6).
- **Workaround (Handoff):**
  - Desk flags work with no runner report for 2 minutes.
  - Agents flags a runner stale after 45 s without a heartbeat.
  - Stop also cancels the delegation, which fences the runner's next call (CLAIM_LOST; browser check).
  - Lease expiry is the backstop.
- **Proposed contract:**
  - Control state carries `requestedAt` and `acknowledgedAt` for stop and interrupt.
  - A deadline is declared on the task, and the state becomes `unresponsive` when it passes.
  - The forced path stays FeltKit's own: cancel the invocation and revoke the lease, never kill a process from the app.

## PG-5 · FeltKit live queries: no time-based re-evaluation (new, minor)

- **Owner:** FeltKit (live queries).
- **Problem:**
  - Derived, time-dependent read models (for example the Desk's "no runner report for N min") are recomputed only
    when a record they read changes.
  - In Handoff this is masked incidentally: the GitHub polling job writes the `sync` record every 30 s, and
    `work:desk` reads it.
  - Remove the polling, and the Desk's staleness freezes.
- **Workaround:** the incidental refresh above. Agents computes staleness in the browser from `lastSeenAt` on a
  5 s tick. That is display-only, with no authority.
- **Proposed contract:** a query option such as `revalidateAfterMs`, or a documented clock dependency.

## Corrections to earlier assumptions (no gap)

| Earlier assumption | Correction |
| --- | --- |
| Evidence A's suggestion that "EVE must emit call or usage facts" | Wrong. EVE 1.0.2 already emits `call.started`, `call.progress`, `step.*` and `usage.recorded` (`eve2/packages/eve/src/harness/facts.ts:118-127`; catalog `protocol/session-events/catalog.ts:129`). The gap was in Handoff's runner, now fixed: it carries `call.started` with `callId`, and usage. |
| Evidence D's "a refused heartbeat is retried forever" | Only the heartbeat log line retries. The runner's main loop exits with code 3 on UNAUTHORIZED (`runner.mjs`, last line). No change needed. |
| Steering instructions are stranded when an attempt is taken over | They aren't. The runner reuses the generation's agent task (`runner.mjs:100`), so a takeover attempt's first checkpoint delivers pending instructions. |

## Not platform gaps (Handoff work, listed for completeness)

These are Handoff's own work and are tracked in [PRODUCT-IMPLEMENTATION-PLAN.md](PRODUCT-IMPLEMENTATION-PLAN.md):

- GitHub commit statuses and required-check flags (another read operation on Handoff's existing `github` integration)
- Review staleness against the head SHA, and mergeability
- Plan and todo items from EVE
- Live command-output tail (blocked on a transient channel; see the plan)
