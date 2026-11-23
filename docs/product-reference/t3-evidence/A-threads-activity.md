# T3 reference A: threads, turns, activity, tool status, usage, failure

Read-only audit of `/home/user/rkendel1/t3code`, compared with Handoff (`/home/user/handoff`) as of 2026-11-23.
T3 is a product and interaction reference here, not code to port.

Path prefixes:
`C:` = `packages/contracts/src/`, `S:` = `apps/server/src/`, `W:` = `apps/web/src/`, `CR:` = `packages/client-runtime/src/`, `PC:` = `packages/provider-core/src/`.
Handoff paths start with `H:` (`/home/user/handoff/`).

Each section has **Facts** (with file:line) and **Judgment** (for Handoff). The tables at the end map each capability to its home.

---

## 0. The T3 model in one page (facts)

- **Entity hierarchy.** A thread has **runs** (one per user message that starts work; `C:orchestrationV2.ts:819`).
  A run has **run attempts** (`C:orchestrationV2.ts:878`, `reason: initial | steering_restart | retry | provider_recovery`, status adds `superseded`).
  Each attempt binds to a **provider thread** and a **provider turn** (`:1345`, which carries `tokenUsage`, `turnTokenUsage`, the reported `model` and `promptDropped`).
  An **execution node** tree (`:903`, kinds `root_turn | tool_call | approval_request | subagent | …`) hangs off the run.
  **Turn items** (`:1893`) are the transcript rows: `user_message, assistant_message (phase commentary|partial_answer|final_answer), reasoning, proposed_plan, todo_list, file_change, command_execution, file_search, web_search, approval_request, user_input_request, checkpoint, run_interrupt_request/result, system_notice, error, compaction, handoff, fork, subagent, dynamic_tool, …`.
  **Provider sessions** (`:1102`, status `starting|ready|running|waiting|stopped|error`, `lastError`, `startupPhase`) and **runtime requests** (`:1409`, approvals and user input, `pending|resolved|expired|cancelled`) sit beside them.
- **Statuses.** Run: `preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back` (`:718`).
  Turn item: `idle, pending, running, waiting, completed, failed, cancelled, interrupted` (`:1690`).
- **Persistence (durable).** SQLite holds an append-only event log `orchestration_v2_events(sequence, event_id, command_id, thread_id, run_id, node_id, raw_event_id, event_type, payload_json)` (`S:persistence/Migrations/055_OrchestrationV2.ts:20-38`), idempotent `orchestration_v2_command_receipts` (`:42-51`), and per-entity projection tables (for example `orchestration_v2_projection_turn_items`, `:225-242`).
  Events are whole-entity upserts: `run.updated`, `turn-item.updated`, `provider-turn.updated`, … (`C:orchestrationV2.ts:2175-2330`).
  A durable effect outbox (`orchestration_v2_effect_outbox` with `status`, `attempt_count`, `lease_owner`, `lease_expires_at`, `last_error`; `S:persistence/Migrations/OrchestrationV2/Foundation.ts:102-121`) runs side effects with leases and retry backoff (`S:orchestration-v2/EffectOutbox.ts:342`).
  The event log can be pruned (`S:persistence/OrchestrationEventStore.ts:37-38`, `S:persistence/DatabaseMaintenance.ts:246`), so the projections are the long-lived record.
- **Transient.**
  - Live updates are coalesced over a 50 ms window: streaming assistant and reasoning text, and running tool items (`S:orchestration-v2/ThreadLiveEventCoalescer.ts:18-48`).
  - Command stdout bypasses the event log: `CommandOutputHub` streams tails at about 100 ms per frame, keeps 64 live and 16 finished tails in memory, and only the settled output is persisted (`S:orchestration-v2/CommandOutputHub.ts:28-45`).
  - Collapsed work is sent as a `deferredWork` cursor and fetched on expand (`C:orchestrationV2.ts:1768-1776`). Command output can be withheld on the wire (`outputOmitted`, `:1974`).
- **Streaming protocol.** The client subscribes with a resume cursor (`sequence`). The server replays, then sends `synchronized`. When it cannot replay, it sends `snapshot-required`, and the client loads an HTTP snapshot and resubscribes (`C:orchestrationV2.ts:2576-2612`).
  Unknown event or turn-item types are skipped while the cursor still advances (`:4401-4425`), which keeps old clients forward-compatible.
- **Authority.** One RPC, `dispatchCommand`, requires the `orchestration:operate` scope (`S:auth/RpcAuthorization.ts:46`); reads need `orchestration:read`. Commands carry a `commandId`, and a repeated `commandId` replays the stored receipt instead of acting again (`S:orchestration-v2/Orchestrator.ts:16362-16374`, `:16304-16344`).

---

## 1. Send a message / start a turn

- **User problem:** give the agent work, or add to work in progress, without losing anything.
- **Action and transition (facts):**
  - `message.dispatch` (`S:orchestration-v2/Orchestrator.ts:16054`) takes a dispatch mode: `start_immediately`, `queue_after_active`, `steer_active`, `restart_active` or `defer_start` (`C:orchestrationV2.ts:3628-3636`).
  - The user message becomes a `user_message` turn item whose `inputIntent` is `turn_start | queued_turn | steer | promoted_queued_to_steer` (`:1744`).
  - A run is created as `queued` or `preparing`, then `starting` and `running`. The queue can be held, reordered, edited, cancelled or promoted to a steer (`Orchestrator.ts:16137-16230`).
- **Visible (facts):**
  - Before: a queued-runs control (`W:components/chat/QueuedRunsControl.tsx`).
  - During: a `working` or `thinking` row, a live work row with a live thought line, and a minimap (`W:components/chat/MessagesTimeline.logic.ts:534-575`). The sidebar pill shows Working, Connecting, Waiting, Pending Approval or Awaiting Input (`W:components/Sidebar.logic.ts:1233-1320`). A startup phase comes from `ProviderSession.startupPhase` (`C:orchestrationV2.ts:1118-1122`).
  - After: the turn folds to "Worked for {duration}", or "You stopped after {duration}" (`MessagesTimeline.logic.ts:1265-1272`).
- **Durable:** the run, the message and the turn item are all projection rows written from the event log.
- **Failure:** see §6. Queue resume is refused while a usage limit holds or worktree setup is pending (`Orchestrator.ts:16163-16185`).
- **Retry safety:** the client-supplied `commandId` makes dispatch idempotent (receipt replay).
- **Local-specific:** `workspacePreparation` (worktree strategy, `C:orchestrationV2.ts:782-806`) prepares a local git worktree before the turn.
- **Handoff today:** delegation → generation → attempt, with steering through FeltKit agent control (`H:src/AgentControl.tsx`): signal, submit, withdraw, pause, resume, interrupt and stop.
  Handoff has no queue of follow-up messages. A "return" starts a new generation (`H:feltkit/work.ts:89-112`).
- **Judgment:** T3's intent labels on user input (`steer` vs `queued_turn`) are worth copying as metadata on Handoff instructions. FeltKit already models signal and submit, so the instruction record belongs in FeltKit, not Handoff. Per-thread queueing is chat-specific and does not apply to delegation.

## 2. Turn / attempt structure and folding

- **Facts:**
  - Attempts are first-class. A steering restart or retry produces a new attempt and marks the old one `superseded` (`C:orchestrationV2.ts:888-898`).
  - The UI folds superseded attempts' output under an `attempt-fold` row (`MessagesTimeline.logic.ts:608-616`, `:848-900`), but keeps a reply that was explicitly `final_answer` or that completed before supersession (`:792-846`).
  - Codex goals can span several provider turns within one attempt (`C:orchestrationV2.ts:1379-1393`).
  - `promptDropped` marks a provider turn whose request never reached native history (`:1366-1377`).
- **Handoff today:** `timeline` already layers generation → attempt → session → turn → activity and tags every entry with a trust level of `reported | observed | verified | decided | system` (`H:feltkit/work.ts:150-195`). **`src/App.tsx` does not use `timeline`.** The Run section renders a flat list of the last 200 `runEvents` (`H:src/App.tsx:190-193`).
- **Judgment:** Handoff's data model is already right for this. The gap is the UI. Borrow T3's fold behaviour:
  - Collapse each finished turn to one summary line.
  - Collapse superseded attempts under "Attempt N (superseded)".
  - Keep failures expanded (`itemizedFailedRunIds`, `MessagesTimeline.logic.ts:1055-1072`: failed runs show their work itemized; usage-limit pauses keep their groups).

  This is Handoff UI work.

## 3. Activity and transcript presentation

- **Facts:**
  - Turn items become `WorkLogEntry` (`W:session-logic.ts:71-98`) with a `tone` of `thinking | tool | info | error` and a `toolLifecycleStatus` of `idle | inProgress | completed | failed | declined | stopped` (`:63-69`, mapping at `:272-290`).
  - Consecutive tool entries group under a `work-toggle` row whose summary is generated ("Read 3 files, ran 2 commands, and changed 1 file"; `CR:work-log/presentation.ts:585-647`, `summarizeToolGroup` `:710`). The row carries a `hasFailure` flag (`MessagesTimeline.logic.ts:577-590`).
  - A per-user setting can hide successful tool calls (`hideSuccessful`), but failures always show (`CR:work-log/presentation.ts:400-407`).
  - Images the agent viewed stay visible while the group is collapsed (`MessagesTimeline.logic.ts:592-597`).
  - Row components: `W:components/chat/TimelineWorkEntryRow.tsx:284` (work rows, expandable body), `TimelineWorkGroupRows.tsx`, `TimelineV2EventRow.tsx:21` (event cards, subagent groups), `TimelineAssistantRows.tsx` (assistant meta with the turn diff summary, `:93`), `ProposedPlanCard.tsx`, `CommandBlock.tsx` and `ShellCommandBlock.tsx`, `CommandOutputPanel.tsx:27` (live tail subscription), and `V2ItemInspector.tsx` (raw item inspector).
  - Reasoning shows as a one-line "live thought" preview capped at 2 KB (`W:components/chat/TimelineWorkEntryRow.logic.ts:208-214`).
- **Durable vs transient:** the item status and settled output are durable. Live output tails and streaming text deltas are transient (§0).
- **Handoff today:**
  - The runner maps EVE facts to `runEvents` of kind `progress | tool | command | test | message | warning | error` (`H:feltkit/app.ts:97-103`; mapping in `H:runner/src/runner.mjs:207-217`).
  - Text is truncated to 4000 characters (`H:feltkit/runner.ts:142`). Events are deduplicated by `(attempt, seq)` (`:140`).
  - There is no item id, so a tool call's start and end cannot be correlated.
- **Judgment:**
  - Borrow the grouped summary line, failure-pinned groups, a "hide successful tool calls" toggle, and expand-for-detail. These are Handoff UI work.
  - Adding a stable `callId` (item id) and parent ids to `runEvents` requires a runner and Handoff schema change.
  - A generic "agent activity item" schema with lifecycle could live in EVE/FeltKit, so every app gets it. Handoff should not invent a parallel one.

## 4. Tool execution lifecycle and status

- **Facts:**
  - Tool-like items move `pending → running → completed | failed | cancelled | interrupted`, and `waiting` is used while approval is pending (`C:orchestrationV2.ts:1690-1699`).
  - `command_execution` carries `input`, `output`, `exitCode`, `outputIndicatesFailure`, `monitor` and `completionWake` (`:1970-1983`).
  - Failure display is **heuristic** (`CR:work-log/presentation.ts:329-363`). A failed or declined status or an error tone counts as failure. Otherwise the exit code is used ("exit code outranks text", `:352-353`). If there is no exit code, the output text and even the command string are pattern-matched (`toolOutputIndicatesFailure`). Reasoning text is explicitly excluded from scanning (`:340-343`).
  - Approvals: an `approval_request` row turns into `TimelinePendingApprovalRow` while a pending request exists (`W:components/chat/TimelineWorkEntryRow.tsx:333-337`). Answering it dispatches `runtime-request.respond` (`Orchestrator.ts:16087`). A request whose session died becomes `not_resumable` (`C:orchestrationV2.ts:1419-1427`).
- **Handoff today:**
  - The runner emits a tool event only when the call settles (`H:runner/src/runner.mjs:210-216`), so a long-running tool is invisible until it ends.
  - `status` is a free string (`H:feltkit/runner.ts:126`).
  - The runner sets `failed` from the outcome and a non-zero exit code. It does no text heuristics (good).
- **Judgment:**
  - Report `call.requested` as an in-progress item, then update it by `callId`. That requires the runner, schema and UI.
  - Keep failure **reported** (outcome and exit code) separate from any **inferred** failure. If Handoff ever pattern-matches output, label the result "looks like a failure". T3's text heuristic would blur Handoff's trust levels.
  - Approvals already go through FeltKit (`approval.digest`, `H:feltkit/runner.ts:175-184`), which is the right home.

## 5. Plans, diffs, checkpoints

- **Facts:**
  - `proposed_plan` (markdown) and `todo_list` items with per-step `pending | running | completed` and step durations computed server-side (`S:orchestration-v2/ProviderEventIngestor.ts:88-146`).
  - `file_change` items carry provider-reported `diffStr`, additions and deletions (`C:orchestrationV2.ts:1958-1968`).
  - Separately, `checkpoint` items record files from git snapshots taken by T3 itself under hidden refs (`refs/t3/...`; `S:orchestration-v2/CheckpointCaptureService.ts`, `S:checkpointing/CheckpointStore.ts`).
  - The assistant row's turn diff summary comes from those checkpoints. `checkpoint.rollback` restores them (`Orchestrator.ts:16233`).
- **Local-specific:** checkpoint capture and rollback need direct access to the working tree. This does not apply to Handoff, whose diff evidence is the GitHub PR diff.
- **Judgment:** T3 itself distinguishes "the agent said it changed X" (`file_change`) from "git shows X changed" (`checkpoint`). That is the same split as Handoff's `reported` vs `observed`. Borrow the visual pattern: a diff stat chip on the turn summary, sourced only from GitHub facts and labelled "observed". Plans and todo lists, if EVE exposes them, are reported claims and must be labelled as such.

## 6. Failure presentation (provider crash, disconnect, retry)

- **Facts:**
  - Failures are structured as `{class: usage_limit | provider_error | transport_error | permission_error | validation_error | unknown, message (≤4 KB, redacted), code, retryable, resetAt}` (`C:orchestrationV2.ts:1712-1734`). Provider-internal retries are `{attempt, maxAttempts, retryDelayMs}` (`:1737-1741`).
  - The UI labels these "Retrying provider (2/5) … Retrying in 3s", "Provider recovered (n retries)" and "Provider error after n retries" (`W:session-logic.ts:311-370`). The error row shows the message and a Retry button only for a failed workspace preparation (`TimelineWorkEntryRow.tsx:338-404`; server side `Orchestrator.ts:12846-12880`).
  - **Provider crash or stream end:** the session is released with `runtime_error`, and a bounded message becomes `lastError`, which is the banner text. The raw cause goes only to the log (`S:orchestration-v2/ProviderSessionManager.ts:3153-3175`). Category text with guidance ("Retry the turn; if it keeps failing…") comes from `PC:server/failure.ts:51-68`. A request that is too large (HTTP 413) is called out as not retryable (`:44-49`).
  - **Server restart mid-turn:** startup reconciliation cancels nonterminal runs, attempts, nodes, provider turns and running items (`S:orchestration-v2/ProviderRuntimeRecoveryService.ts:91-101`, `:680-740`). It then appends a `system_notice` titled "Server restarted" or "Server shut down" to each cut run (`:791-830`). Restart continuations can resume work (`RestartContinuation.ts`).
  - **Unresponsive stop:** after Stop, a `run_interrupt_request` gets `unresponsiveAt` if the provider does not confirm in time (`Orchestrator.ts:13557-13600`). The UI then offers "Force stop", which kills processes (`W:components/chat/ThreadActivityBanners.tsx:153-189`, `useForceStopThread.ts:17-27`).
  - **Client disconnect:** the client shows "Loading / Syncing messages… / Could not sync messages" (`W:threadSync.ts:6-39`, `ThreadNow.tsx:61-71`) and resumes from its cursor. The server-side run is unaffected.
  - Provider health banner: `W:components/chat/ProviderStatusBanner.tsx:139-241`.
  - Database lock timeouts during ingest retry twice and are safe, because nothing publishes before commit (`ProviderEventIngestor.ts:74-80`).
- **Retry safety (facts):**
  - Command dispatch is idempotent by `commandId`. Effects are outbox rows with attempt counts and leases.
  - Workspace-preparation failures have an explicit retry.
  - Provider-turn failures are retried by sending again (a new run or attempt), not by replaying the old turn.
- **Handoff today:**
  - `runner.fail` takes a code and an `effect: none | possible` (`H:runner/src/runner.mjs:149, 248, 259`). The unknown-write rule is never to resend and to return as a new generation (`H:docs/IMPLEMENTATION-REPORT.md`).
  - Lease expiry is surfaced (`H:feltkit/runner.ts:32`).
  - There is no structured failure class, no retry counter, and no "unresponsive stop" state.
- **Judgment:**
  - Adopt the failure shape (`class`, `code`, `retryable`, `resetAt`, bounded message, raw cause kept out of the UI) for `runner.fail` and for error events. Handoff's `effect: none | possible` is stronger than T3's `retryable` for side-effecting work; keep both.
  - Adopt a system notice on recovery: "Runner lease expired; attempt N abandoned".
  - Unresponsive-stop and force-stop belong in FeltKit agent control or EVE, not Handoff.
  - Provider-internal retry counters belong in EVE's runtime facts.

## 7. Usage and cost

- **Facts:**
  - Per provider turn, `turnTokenUsage` has `usageStatus: complete | partial | unavailable`, input, cached, cache-creation, output and reasoning tokens, `hasSubagents`, `models`, `localCommand` and `otherUsage` (`C:providerRuntime.ts:56-86`).
  - Per provider thread, `contextUsage` holds used and max tokens, the auto-compact threshold and an optional provider-reported `cost {amount, currency}` (`C:providerRuntime.ts:30-54`).
  - The web app shows **context window** (percent or tokens used) and **usage limits** (windows, reset times, pace) in thread details (`W:components/chat/ThreadDetailsUsage.tsx:69-160`). The usage-limit error row shows the reset time with the time zone (`TimelineWorkEntryRow.tsx:339-351`).
  - Per-turn token counts are stored but not rendered in the web timeline: `turnTokenUsage` has no `apps/web` consumer. It feeds telemetry (`S:telemetry/ProviderUsageAnalytics.ts`).
  - The global **Usage page** builds cost by **scanning local provider transcript files** (`S:usage/usageTranscriptReader.ts`; the source fingerprint is host id, home path and volume, `C:usage.ts:78-84`) and pricing them. `costSource` is `providerReported | modelPriced | unpriced` (`C:usage.ts:33`, `S:usage/usagePricing.ts:374-395`). The UI labels cost "API estimate" and discloses the unpriced share (`W:components/usage/UsagePage.tsx:702-717`).
- **Local-specific:** transcript scanning of `~/.claude` and `~/.codex` is purely local and does not apply to Handoff.
- **Handoff today:** no usage or cost at all.
- **Judgment:**
  - Adopt the provenance-tagged cost pattern: every number says whether it is provider-reported, priced from a model table, or unpriced, and partial usage says so.
  - Per-attempt usage should come from EVE (session and turn facts) and be stored as a **reported** runtime fact by the runner. Aggregation and budgets belong in FeltKit or AppPort Services, not Handoff.
  - Handoff should show per-delegation and per-attempt totals with the `usageStatus` and source label.

## 8. Thread-level status indicators

- **Facts:** the sidebar pill priority is Pending Approval > Awaiting Input > Guest Request > Working > Connecting > Waiting > Failed > Plan Ready (`W:components/Sidebar.logic.ts:1233-1320`). Background work keeps "Waiting" until it settles (`:1308`).
- **Handoff today:** `desk` groups work into needs, moving and done (`H:feltkit/work.ts:200-226`). Badges show the delegation state.
- **Judgment:** Handoff's `desk.needs` is the equivalent. Borrow the idea of one derived, priority-ordered "what does this need from me" label per row. Handoff UI work.

---

## 9. Patterns worth borrowing (components)

| Pattern | T3 location | Handoff use |
| --- | --- | --- |
| Turn fold, "Worked for 4m" | `W:components/chat/MessagesTimeline.logic.ts:1074-1314` | Collapse each attempt/turn in `timeline` |
| Superseded-attempt fold | `MessagesTimeline.logic.ts:848-900` | Earlier attempts and generations |
| Tool group summary sentence plus failure flag | `CR:work-log/presentation.ts:585-647, 710` | Group `runEvents` by turn |
| Hide successful tools, never failures | `CR:work-log/presentation.ts:400-407` | Viewer toggle |
| Live tail for long commands, settled output persisted | `S:orchestration-v2/CommandOutputHub.ts`, `W:components/chat/CommandOutputPanel.tsx` | Only if EVE streams output; keep tails transient |
| Structured failure with retry progress | `C:orchestrationV2.ts:1712-1741`, `W:session-logic.ts:311-370` | `runner.fail` and error events |
| Recovery system notice on cut runs | `S:orchestration-v2/ProviderRuntimeRecoveryService.ts:791-830` | Lease expiry and abandoned attempt |
| Unresponsive stop, then Force stop | `W:components/chat/ThreadActivityBanners.tsx:153-189` | FeltKit agent-control state |
| Sync state line | `W:threadSync.ts`, `W:components/chat/ThreadNow.tsx` | Live query or SSE disconnect indicator |
| Cost source labels, "API estimate", unpriced share | `W:components/usage/UsagePage.tsx:702-717` | Usage display |
| Forward-compatible unknown event or item skipping | `C:orchestrationV2.ts:4401-4425` | Handoff UI over evolving EVE kinds |
| Idempotent command receipts | `S:orchestration-v2/Orchestrator.ts:16304-16374` | Already FeltKit's role (invocations and receipts) |

## 10. Patterns that conflict with Handoff's evidence model

1. **The transcript treats model output as the record.**
   - Assistant messages, `file_change` diffs, plans and todo "completed" steps all render with the same authority as observed state.
   - The only trust signal is `assistant_message.phase` (commentary vs `final_answer`, `C:orchestrationV2.ts:1766`), which describes the message's role, not whether it is true.
   - Handoff must keep labelling every agent statement as **reported**, and render only GitHub facts as observed or verified.
2. **Heuristic failure from output text** (`CR:work-log/presentation.ts:355-362`). This is acceptable as a display hint, but it is inference. Handoff should not mix it into reported or verified state without an "inferred" label.
3. **`file_change` diffs from the provider** look like real diffs. In Handoff, a diff is evidence only when it comes from GitHub (`facts`), never from runner text.
4. **Status from the client's own write path.** T3 is single-owner and local: the server owns both the agent process and the projection, so `completed` means "the process said so". Handoff's runner is an external, self-asserted reporter (`instanceAuthenticated: false`, `H:feltkit/work.ts:193`). Statuses Handoff copies from the runner must stay `reported`.
5. **Event-log pruning** (`S:persistence/OrchestrationEventStore.ts:37`). T3 can drop raw history because it is not a system of record. Handoff's history and audit trail must not be pruned in this way.
6. **Automatic recovery and continuation** (`RestartContinuation.ts`) resends prompts after a restart. In Handoff, a re-run after a possibly-effectful failure must be a person's decision (a new generation), which is what Handoff already does.

## 11. Placement summary

| Capability | Handoff has it? | Home |
| --- | --- | --- |
| Layered timeline (generation → attempt → session → turn → activity) | Query yes (`work.ts:156`); **UI no** | Handoff (UI) |
| Turn and attempt folding, grouped tool summaries | No | Handoff UI |
| Tool lifecycle with item ids (start, progress, settle) | No (settle-only, no id) | EVE emits; runner and Handoff schema carry `callId` |
| Live command output tail | No | EVE stream; FeltKit transport; Handoff view (transient) |
| Structured failure class, code, retryable, resetAt | Partial (`code`, `effect`) | Runner and Handoff schema; EVE for provider retry facts |
| Recovery notices (lease expiry, abandoned attempt) | Lease shown; no notice | Handoff (history entry) |
| Steer, queue intent labels | Steering via FeltKit | FeltKit agent control |
| Unresponsive stop and force stop | No | FeltKit / EVE |
| Approval requests in the timeline | Via FeltKit approval | FeltKit (Handoff renders) |
| Usage and cost with provenance | No | EVE reports; FeltKit or AppPort Services aggregate; Handoff displays |
| Usage limits and reset windows | No | Not applicable (provider-account level); possibly AppPort Services |
| Git checkpoints and rollback | No | Not applicable (local working tree); GitHub facts replace it |
| Transcript-file cost scanning | No | Not applicable (local) |
| Idempotent commands | Yes (FeltKit invocation, `(attempt, seq)` dedupe) | FeltKit |
| Sync and disconnect indicator | No | Handoff UI over FeltKit live queries and SSE |

## 12. Open uncertainties

- I did not trace every adapter (Claude and Codex adapters are over 9k lines each) to confirm how consistently `usageStatus` and `retry` are filled per provider.
- Whether EVE exposes in-progress call facts, plan or todo facts, or token usage was not checked here. The runner only consumes `turn.*`, `call.*` and `content.completed` (`H:runner/src/runner.mjs:207-217`).
