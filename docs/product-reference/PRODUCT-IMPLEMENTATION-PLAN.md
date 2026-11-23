# Product implementation plan: Handoff after the T3 reference

What this phase changed in Handoff, in what order, and what is next. The capability matrix is
[T3-REFERENCE-MAP.md](T3-REFERENCE-MAP.md); platform items are in [PLATFORM-GAPS.md](PLATFORM-GAPS.md).

## Principles that decided what to build

1. **Borrow the user problem, not the mechanism.** T3 solves one person's local session. Handoff solves delegated,
   durable work. A T3 pattern was adopted only where the same problem exists for a delegator or reviewer.
2. **Handoff's evidence model wins conflicts.** Agent statements stay *reported*; GitHub reads are *observed*; a
   match is *verified*; people *decide*; runner self-descriptions are *asserted*. Where T3 blurs these (A §10), we
   did not copy it.
3. **Reuse the platform; record gaps before working around them.** Lifecycle, leases, approvals, steering, sessions,
   jobs and credentials stay FeltKit's. Each workaround here sits inside Handoff's boundary and names its PG item.
4. **Deterministic first.** Nothing added in this phase uses a model. The UI is a view over records and FeltKit state.

## Done in this phase

| # | Area | Change | Evidence |
| --- | --- | --- | --- |
| 1 | Desk | Attention groups with reasons: approval, waiting for a person, failed or uncertain, review, assignment, active, recently accepted | `work:desk`; product test "the Desk groups…"; browser check; `docs/evidence/ui/07-desk.png` |
| 2 | Work | Lifecycle stepper; request; approval card with digest and expiry; steering; execution (attempts → sessions → turns, open tool calls, usage); source control; result vs GitHub; layered and filterable timeline with trust labels | `work:timeline`; product tests; browser check; `08-work-detail.png`, `09-source-control.png` |
| 3 | Source control | Diff (files, counts, patches, truncation), commits, check runs, reviews, read from GitHub and recorded only on change | `github:observeSourceControlNow`; product test "source-control evidence…" |
| 4 | Runtime capabilities | Declared per runner, normalized, shown; unsupported controls disabled with a reason | product tests; browser check; PG-3 |
| 5 | Agents | Definitions; runners with state, runtime, current work, last heard, staleness, capabilities, observed session ref, session-ended state | `admin:listWorkers`; `10-agents.png`; session probe |
| 6 | Settings | Repository connection checks; GitHub sync; execution policy (bounded, person-only, with provenance); approval rules; credential references; capability vocabulary | product tests; `11-settings.png` |
| 7 | Policy | `maxAttempts` and lease bounds enforced at the claim boundary | product test "execution policy…" |
| 8 | Runner identity | Session ref observed on heartbeat and claim; `auth.onSessionEnd` marks revoked runners | `scripts/session-probe.mjs` → `docs/evidence/session-probe.json` |
| 9 | Activity | `call.started` with `callId` (open calls), `usage.recorded` (tokens; cost only when reported) | product test "tool calls link…"; runner syntax checked; the live EVE run is listed in the report |
| 10 | Safety | Credential-shaped runner text masked at the boundary; PR closed without merge never verified or accepted | product tests "credential-shaped text…", "a pull request closed…" |
| 11 | Approval read-back | Decision re-read from FeltKit into history so open views refresh | product test; PG-1 |

## Next, in order

Ordered by user value per unit of risk. None needs a platform change unless marked.

1. **Checks and reviews completeness (Handoff).** Read commit statuses alongside check runs. Mark required checks.
   Show "approved an earlier head" by comparing each review's `commit_id` with the PR head. Show mergeability.
   *Why first:* a reviewer currently can't see statuses-based CI, and a stale approval looks current.
2. **Per-generation diff (Handoff).** Previous generation's head → this head, beside base → head, so a reviewer of
   returned work sees only what changed in response.
3. **Turn summaries (Handoff UI).** Duration and tool-count per turn, folded when finished; failures stay open.
4. **Failure shape (runner + schema).** Class (provider, transport, permission, validation, unknown), retryable,
   and resetAt next to the existing `effect`. Desk explains *what a person can do* per class.
5. **PR watch wakes the agent (Handoff + FeltKit jobs and agent control).** When checks fail or changes are
   requested on a reported PR, offer "send to the agent" (a person still chooses; nothing auto-resends).
6. **Rejection reason to the agent (runner).** On APPROVAL_REJECTED, deliver the reason as an instruction if the
   delegator returns the work.
7. **Live output tail.** Deferred until a transient channel exists. FeltKit agent-control SSE is the candidate; it
   must not be persisted as evidence.
8. **Platform-dependent:** server-side capability refusal (PG-3), stop deadline (PG-4), approval in the change feed
   (PG-1, which would remove the read-back workaround), per-runner principals (PG-2).

## Deliberately not built

- History pruning, auto re-send after a restart, failure inference from output text (conflict with the evidence
  model).
- Worktrees, checkpoints and rewind, local commit UI, terminals, Tailscale and SSH, pairing codes (local-first
  concerns; EVE sandbox and FeltKit sessions cover Handoff's needs).
- A price table for cost estimates (only provider-reported cost is shown).
- Merging from Handoff (people merge on GitHub).
