# T3 evidence B: provider sessions, capability declarations, approvals, steering, interrupt, agent-to-agent, MCP, terminals

Read-only audit of `/home/user/rkendel1/t3code` at commit `fab237d6`. T3 is a product and interaction reference here, not code to port.
All paths below are relative to that repository unless they start with `handoff/`.
Each section separates **Facts**, which cite file:line, from **Judgments**, which are this audit's opinion.

Abbreviations: `contracts` = `packages/contracts/src`, `core` = `packages/provider-core/src/server`, `o2` = `apps/server/src/orchestration-v2`, `cr` = `packages/client-runtime/src`, `web` = `apps/web/src/components`.

---

## 0. The three patterns that matter most to Handoff

1. **Capabilities are typed, grouped, persisted on the session record, and used to decide behavior on the server.** A provider adapter returns `OrchestrationV2ProviderCapabilities` (`contracts/orchestrationV2.ts:431-447`), a struct of 12 groups of booleans and enums. The struct is stored on every `ProviderSession` (`contracts/orchestrationV2.ts:1109`). The server uses it to route a message: steer the turn, restart it, or queue the message (`o2/CommandPolicy.ts:206-244`, `:320-341`). The client reads the same struct only to enable or disable affordances (`cr/state/threadWorkflows.ts:106-131`, `:171-222`). Some capabilities are not declared up front. They are negotiated after the handshake: ACP narrows them using what the agent's `initialize` returned (`packages/provider-acp/src/server/adapter.ts:999-1038`).
2. **An approval is a durable `RuntimeRequest` with a typed *response capability*.** `responseCapability` is one of `live{providerSessionId}`, `message`, or `not_resumable{reason}` (`contracts/orchestrationV2.ts:1409-1433`). The server resolves and persists the decision first. Delivering it to the provider is a separate, retried effect (`o2/Orchestrator.ts:11612-11835`, `o2/EffectWorker.ts:498-534`, `o2/RuntimeRequestService.ts:89-123`). If delivery fails, the decision stays recorded and the timeline shows "Answer delivery not confirmed" (`o2/Orchestrator.ts:11839-11896`).
3. **Policy is enforced in one of two declared ways.** Under `runtimePolicy.enforcement: "native" | "client-boundary"` (`contracts/orchestrationV2.ts:417-446`), either the provider enforces the mode itself (Claude, Codex, OpenCode, Cursor), or T3's own client code decides allow, ask, or deny for each permission request (ACP, Pi) (`packages/provider-acp/src/server/clientPolicy.ts:77-201`). An administrator ceiling (`maxRuntimeMode`) is re-checked on the server when work starts (`o2/RuntimePolicy.ts:93-129`, `o2/DispatchModeLimit.ts:67-94`).

---

## 1. Provider capability declaration and negotiation

**Facts**
- The schema groups are `sessions`, `threads`, `turns`, `streaming`, `tools`, `approvals`, `planning`, `subagents`, `context`, `checkpointing`, `identity`, and `runtimePolicy` (`contracts/orchestrationV2.ts:301-447`). The turn fields are `supportsInterrupt`, `supportsNativeResume?`, `supportsActiveSteering`, `activeSteeringInterruptsTools?`, `activeSteeringAcceptsAttachments?`, `activeSteeringDuringCompaction?`, `supportsSteeringByInterruptRestart`, `supportsQueuedMessages`, and `terminalStatusQuality: strong|weak|none` (`:323-341`). The session fields are `supportsModelSwitchInSession`, `supportsRuntimeModeSwitchInSession`, `supportsProviderSwitchingViaHandoff`, and `pendingRequestsSurviveRestart` (`:301-307`). The approval fields are `supportsCommandApproval`, `supportsFileReadApproval`, `supportsFileChangeApproval`, `approvalCallbacksAreLiveOnly`, and `approvalsCanOriginateFromSubagents` (`:365-373`).
- New optional fields are added as `optional` so that older records still decode. `runtimePolicy` gets a decoding default of the weaker `client-boundary` for replayed events (`contracts/orchestrationV2.ts:329-330`, `:443-446`).
- The adapter contract has `getCapabilities()` on the adapter (`core/ProviderAdapter.ts:883-886`). Optional methods are a second form of declaration: `resumeTurn?`, `compactThread?`, `applyModelSelection?`, `stopSubagent?`, `mcpApps?`, and `mcpSignIn?` ("Absent means…") (`core/ProviderAdapter.ts:808-872`). `canResumeAfterRestart?` and `backgroundTasksEndWithProcess?` are also optional (`:768`, `:784`).
- Typed "unsupported" errors exist: `ProviderAdapterSteerRunUnsupportedError`, `ProviderAdapterSteerDeclinedError`, `ProviderResumeUnsupportedError` ("This provider cannot resume without a new message. Send a message to continue."), and `ProviderAdapterInterruptTimeoutError` (`core/ProviderAdapter.ts:326-333`, `:414-436`, `:464-470`).
- Static declarations differ by provider:
  - Claude: steer yes, interrupt-restart no, native resume yes, runtime-mode switch in session no (`o2/Adapters/ClaudeAdapterV2.ts:630-656`, `:673-681`).
  - Codex: steer yes, interrupt-restart yes, steer during compaction yes, mode switch yes, apply-patch approval yes, approvals can come from subagents (`o2/Adapters/CodexAdapterV2.ts:301-325`, `:343-350`).
  - ACP: steer no, interrupt-restart yes, native resume no, model switch no unless negotiated, enforcement `client-boundary` (`packages/provider-acp/src/server/adapter.ts:856-878`, `:896-903`, `:945`).
  - Pi: steer yes, enforcement `client-boundary` (`packages/provider-pi/src/server/adapter.ts:106-132`).
- Negotiation: ACP rewrites `supportsModelSwitchInSession`, `canReadThreadSnapshot`, `canForkThread`, and `supportsActiveSteering` from `initializeResult.agentCapabilities` and the session setup (`packages/provider-acp/src/server/adapter.ts:999-1038`, `:8475-8506`).
- Server use:
  - `CommandPolicy` is a typed refusal service with `CommandPolicyCapabilityUnsupportedError{capability, detail}` (`o2/CommandPolicy.ts:26-54`, `:295-345`).
  - `resolveDeliveryIntent` turns a user's "send now" into steer, restart, or queue from the capabilities (`o2/CommandPolicy.ts:206-244`).
  - A runtime-mode change detaches sessions that cannot switch mode in place (`o2/Orchestrator.ts:4810-4816`).
  - A model or provider change while a run is active is refused with `OrchestratorProviderSelectionBusyError` (`o2/Orchestrator.ts:4786-4795`).
- Client use:
  - `supportsSteering = supportsActiveSteering || (supportsInterrupt && supportsSteeringByInterruptRestart)` (`cr/state/threadWorkflows.ts:106-111`).
  - `threadCanSteer` returns false only when the capabilities are *known* and lack steering. A steer sent before the session attaches can wait (`:113-131`).
  - `canPromoteToSteer` (`:216-220`) and fork eligibility (`:225-245`) also read the capabilities.
  - `web/ChatView.tsx:1567` consumes `threadCanSteer`.
- The runtime-mode picker filters to the provider's `supportedRuntimeModes`. It shows managed-policy denials as `disabledReason` ("{organization} limits threads to {mode}.") (`web/chat/runtimeModeConfig.ts:43-52`, `:72-106`). On the server, an unsupported mode is lowered to `approval-required` (`o2/RuntimePolicy.ts:82-91`).

**Visible** (before, during, after): the mode menu shows only supported modes plus disabled modes with reasons. Steer and "promote to steer" affordances appear only when the session can steer. An unsupported action never reaches the provider; the server answers with a typed refusal.

**Durable or transient:** capabilities are durable. They sit on the `ProviderSession` record in the event-sourced projection and are replayed with defaults.

**Failure:** `ProviderAdapterCapabilitiesError` covers a failure to read the capabilities (`core/ProviderAdapter.ts:253-262`). With no session yet, the client assumes steering may work and the server queues the message (`o2/CommandPolicy.ts:221-231`).

**Authority:** none to read. The declaration is made by the adapter, which is trusted, in-process code.

**Specific to local execution:** the adapters are in-process code that T3 ships, so a capability is a statement by trusted code about a native CLI or SDK. In Handoff, capabilities are self-reported by a remote runner.

**Handoff today (fact):** `handoff/feltkit/_lib.ts:78-85` defines `RUNTIME_CAPABILITIES` as flat enums (`steer`, `pause`, `interrupt`, `resume`, `stop`, `reconnect`). The runner reports them, and they are filtered and stored as `asserted` on the delegation and runner records (`handoff/feltkit/runner.ts:18`, `:147-148`, `:266`). `handoff/src/WorkDetail.tsx:42`/`:75` passes `capabilities={caps}` to `<AgentControl>`. However, `AgentControl`'s props (`handoff/src/AgentControl.tsx:58`) do not declare `capabilities` and never read them. At audit time, Pause, Interrupt, and Update were therefore always enabled, whatever the runner declares, and the unknown prop likely fails `tsc`.

**Judgments**
- **Handoff:** gate each control on the declared capability, and give a reason for each disabled control, as T3 does with `disabledReason`. Examples: "This runner can't pause between steps", or "reconnect: none, so a lost runner means a new attempt". Unknown should be permissive and known-false restrictive, as in T3's `threadCanSteer`.
- **Handoff:** record which capabilities applied to an attempt on that attempt, so that later readers understand why an action was refused. T3 stores them per session, and Handoff already stores them per delegation runtime.
- **Platform (FeltKit agent control):** the control endpoints should refuse operations the bound task's runtime did not declare, with a typed `CAPABILITY_UNSUPPORTED{capability, detail}` like T3's `CommandPolicyCapabilityUnsupportedError`. Today only the UI could refuse them. Capability declaration on the agent task belongs in FeltKit or EVE, not in each app.
- **Not applicable:** T3's 60+ fine-grained flags (streaming, identity strength, fork variants) exist because T3 normalizes many native CLIs. Handoff has one runtime (EVE) and should keep a small vocabulary.

---

## 2. Permission modes (runtime modes) and the administrator ceiling

**Facts**
- `RuntimeMode` is `approval-required | auto-accept-edits | auto | full-access`, ranked 0 to 3, with a default of `full-access` (`contracts/providerPolicy.ts:25-43`). `ProviderInteractionMode` is `default | plan` (`:45-47`).
- Mapping to native settings:
  - Codex: approval-required becomes `untrusted` plus a readOnly sandbox. auto-accept-edits becomes `on-request` plus workspaceWrite. auto becomes `on-request` plus `auto_review` (a provider-side reviewer). full-access becomes granular "never", except for MCP elicitations (`o2/Adapters/CodexAdapterV2.ts:802-840`).
  - Claude: maps to the SDK `permissionMode` values default, acceptEdits, auto, bypassPermissions, and plan (`o2/Adapters/ClaudeAdapterV2.ts:3640-3687`).
- Client-boundary enforcement (ACP): reads are allowed. In approval-required mode, mutations ask. A workspaceWrite sandbox allows edits only inside the canonicalized cwd and writable roots, with symlink-aware containment that fails closed (`packages/provider-acp/src/server/clientPolicy.ts:41-70`, `:77-192`).
- The managed ceiling is enforced in several places:
  - `RuntimePolicyAboveCeilingError` when a turn starts (`o2/RuntimePolicy.ts:36-53`, `:93-129`).
  - Command planning inspects planned events, so every path that creates, switches, starts, or steers is covered. Lowering a mode stays allowed (`o2/DispatchModeLimit.ts:67-94`).
  - The Claude adapter strips `setMode` suggestions under a ceiling, so "always allow" cannot raise the mode (`o2/Adapters/ClaudeAdapterV2.ts:4686-4703`).
- A mode change is a durable command, `thread.runtime-mode.set` (`contracts/orchestrationV2.ts:3566-3571`). If the session cannot switch in place, it is detached and restarted with the new mode (`o2/Orchestrator.ts:4810-4816`).
- UI copy: "Supervised: Ask before commands and file changes", "Auto-accept edits", "Auto: Supported providers approve routine actions; others still ask", "Full access: Allow commands and edits without prompts" (`web/chat/runtimeModeConfig.ts:13-38`).

**Visible:** the mode is shown per thread in the composer. Ceiling-denied modes are disabled with the organization's name.

**Durable:** the thread mode is durable. The ceiling comes from managed policy and is fixed for the server's lifetime (`o2/RuntimePolicy.ts:144-146`).

**Failure:** a thread above the ceiling cannot start work. The message reads "Switch this thread's mode to continue" (`o2/RuntimePolicy.ts:50-52`).

**Authority:** the orchestration operate scope (§12), and the ceiling binds everyone, including the user (`o2/DispatchModeLimit.ts:43`).

**Specific to local execution:** sandboxes are local filesystem and OS sandboxes, and "full access" means the agent has the user's own machine.

**Handoff today:** there are no permission modes. The only gate is "open PR", which requires the delegator's FeltKit invocation approval bound to a digest, branch, and head (`handoff/feltkit/github.ts:118-132`). The runner sandbox is the runner's business.

**Judgments**
- **Handoff, partially:** a per-delegation *autonomy level* is a useful product concept: which consequential actions need approval (open PR, push to a protected branch, run CI, comment on an issue). It should be a policy over Handoff's own consequential actions, not over shell or file operations.
- **Platform (FeltKit, AuthBoundry):** the organization ceiling, meaning the maximum autonomy an organization allows, enforced at planning time. T3's "re-check under the command lock" (`o2/DispatchModeLimit.ts:21-24`) is the right shape.
- **EVE or runner:** command and file sandboxing. It is not applicable to Handoff's server.

---

## 3. Approval request lifecycle (request, decide, deliver)

**Facts**
- Request kinds: `command | file-read | file-change | mcp-elicitation | permission` plus `dynamic_tool_call | user_input | auth_refresh`. Status is `pending | resolved | expired | cancelled` (`contracts/providerPolicy.ts:49-56`, `contracts/orchestrationV2.ts:1409-1433`).
- Providers emit `runtime_request.updated` events (`core/ProviderAdapter.ts` event union, around `:188-193`). A turn's terminal event can list `retainedRuntimeRequestIds` (`:226`, `:247`).
- The command is `runtime-request.respond{requestId, decision?, feedback?, answers?}` (`contracts/orchestrationV2.ts:3727-3736`). The server's `dispatchRuntimeRequestRespond` (`o2/Orchestrator.ts:11469-11837`):
  1. Refuses a missing request, a request that is not `pending`, or a `not_resumable` one, returning the stored `reason` (`:11483-11503`).
  2. Allows feedback only on a `live` request that `supportsFeedback`, with a `decline` decision and non-empty text (`:11504-11517`).
  3. Checks that the provider session exists (`:11518-11529`).
  4. Persists `status: resolved`, `resolvedAt`, `decision`, `feedback`, and `answers`, and updates the request node and turn item. A decline or cancel marks them `cancelled`, otherwise `completed` (`:11541-11755`).
  5. Enqueues an outbox effect, `effect:${commandId}:runtime-request.respond:${requestId}` (`:11820-11835`).
- Delivery: `RuntimeRequestService.respond` requires `status === resolved` ("Dispatch persists resolution before this effect runs"), a `live` capability on the same provider session, and a live session. It then calls the adapter's `respondToRuntimeRequest` (`o2/RuntimeRequestService.ts:78-123`).
- The effect worker retries up to `maxAttempts`, 5 by default (`o2/EffectWorker.ts:803`, `:940`). On the final failure it dispatches `runtime-request.delivery.fail` (`:498-534`). That adds an error turn item, "Answer delivery not confirmed", with class `transport_error`, while the decision stays recorded (`o2/Orchestrator.ts:11839-11896`).
- Message-capable requests: if the native callback is gone but the question can be answered by message, the answer becomes a new `message.dispatch`. The answer steers when the active session supports steering, otherwise it is queued (`o2/Orchestrator.ts:11756-11804`).
- Claude adapter: the decision maps to SDK `PermissionResult` values `allow`/`deny`, with `decisionClassification` of `user_temporary`, `user_permanent`, or `user_reject`. A cancel sets `interrupt: true`. Decline feedback becomes "The user declined this tool call and said:\n…" (`o2/Adapters/ClaudeAdapterV2.ts:4679-4721`). While waiting, the adapter races the user's decision against the turn's abort signal (abort means `cancel`) (`:4744-4757`).

**Visible**
- Before: there is no pre-warning.
- During: a timeline row and the composer show the kind, label, and detail (the command or file), the reason, "Waiting for approval", and buttons for the primary options (Decline, Approve) plus a "More" menu (Cancel, "Always allow this session"). Provider-supplied options carry their own labels and `warning` tooltips (`web/chat/TimelinePendingApprovalRow.tsx:17-40`, `:81-111`; `web/chat/ComposerPendingApprovalActions.tsx:27-41`, `:56-158`). If the process is gone: "Provider process is gone. Interrupt or restart the run to respond." (`:107-110`).
- After: the row is marked completed or cancelled. Decline feedback appears as a user message in the timeline (`o2/Orchestrator.ts:11623-11684`).

**Durable or transient:** the request, the decision, and who decided (through the command and event log) are durable. The native callback is transient: `approvalCallbacksAreLiveOnly: true` for Claude, Codex, and ACP (`o2/Adapters/ClaudeAdapterV2.ts:679`, `o2/Adapters/CodexAdapterV2.ts:349`).

**Failure:** after a server restart, every pending request becomes `expired` with `not_resumable`: "The server restarted before this runtime request was resolved." On shutdown it becomes `cancelled` (`o2/ProviderRuntimeRecoveryService.ts:659-676`). On session release the requests are marked `not_resumable` (`o2/ProviderSessionManager.ts:900-923`). On interrupt: "The run was interrupted." (`o2/Orchestrator.ts:13289-13305`). On thread deletion: "The thread was deleted." (`o2/ThreadDeletion.ts:124`).

**Retry safety:** delivery is idempotent through the effect id and command receipts. A second respond is refused because the request is no longer `pending`. The user cannot re-decide after delivery fails; the answer stays recorded.

**Timeouts:** none for approvals. A request waits until the user decides, the turn is aborted, or the session or server goes away. No approval-timeout code was found; the only matches for "expire" belong to restart handling.

**Authority:** the `orchestration.operate` scope on `dispatchCommand` (`apps/server/src/auth/RpcAuthorization.ts:46`). Any operator of the environment can approve. There is no per-request approver identity check.

**Server-enforced or UI-only:** the decision is enforced on the server (status gate, then a provider callback). The native or client-boundary policy decides whether a request is raised at all.

**Specific to local execution:** approvals are for shell commands and file edits on the user's machine, and the "approver" is the machine owner.

**Handoff today:** one durable approval, "open PR". It is person-only (the delegator), digest-bound to the branch and head SHA, has an `expiresAt`, and is checked server-side inside `runner.openPullRequest` (`handoff/feltkit/github.ts:118-132`; `handoff/src/WorkDetail.tsx:62-71`). Approval resumes a new attempt (`handoff/feltkit/runner.ts:171-200`).

**Judgments**
- **Handoff:** Handoff's approval model is *stronger* than T3's on authority (a named approver, digest binding, expiry). T3 is stronger on lifecycle UX. Borrow these:
  - (a) Record the decision first, then deliver, and if delivery is unconfirmed say so explicitly ("Approved; runner hasn't picked it up").
  - (b) Make `not_resumable{reason}` a first-class state, so a stale approval explains itself ("The attempt that asked for this ended; a new attempt will ask again").
  - (c) Allow decline with feedback that goes back to the agent as an instruction. Handoff could route it through agent control `submit`.
  - (d) Show the exact action detail and a warning per option.
- **Platform (FeltKit invocation approval):** `not_resumable` with a reason, a delivery-failure state, and decline-with-feedback belong in FeltKit so every app gets them.
- **Not applicable:** per-shell-command approvals. Handoff should not proxy EVE tool approvals unless EVE exposes them as invocation approvals.

---

## 4. Approval scoping (once, this session, always) and "why am I asked"

**Facts**
- Decisions are `accept | acceptForSession | acceptAlways | decline | cancel` (`contracts/providerPolicy.ts:58-65`). Options carry `{decision, label, warning?}` (`:72-76`).
- Claude: `acceptForSession` writes the SDK's suggested permission updates with `destination: "session"`, or falls back to an allow rule for the tool name (`o2/Adapters/ClaudeAdapterV2.ts:4723-4742`). MCP elicitations keep an in-memory set, `mcpElicitationSessionGrants` (`:13151-13155`).
- Codex: `acceptForSession` uses `scope: "session"`, and `acceptAlways` is reduced to `acceptForSession`. Per a comment in the code, Codex's session grant "covers only the exact command or patch" (`o2/Adapters/CodexAdapterV2.ts:685-722`, `:2344`, `:6160-6164`).
- Full-access override: `fullAccessOverride: "ask_rule" | "provider_check"` explains why a prompt appears despite full access (`contracts/providerPolicy.ts:67-70`). The UI has a "Why am I being asked this?" popover with two canned explanations (`cr/state/threadRequests.ts:67-84`; `web/chat/TimelinePendingApprovalRow.tsx:113-126`).

**Durable or transient:** the decision is recorded durably. Session grants live in provider or adapter memory and vanish with the session. Nothing in T3 stores "always" grants.

**Authority:** the same operate scope as other approvals.

**Judgments**
- **Handoff:** the "Why am I being asked this?" explanation is directly applicable. Example: "Opening a PR always needs the delegator's approval; you can't turn this off". So is the option-with-warning pattern.
- **Platform:** if "approve all PRs for this delegation" is ever wanted, the grant scope (once, per delegation, per agent) belongs in FeltKit invocation approval, recorded durably. T3's grants are deliberately ephemeral.

---

## 5. Steering mid-turn, queueing, and the steer-miss fallback

**Facts**
- Dispatch modes on `message.dispatch` are `defer_start`, `steer_active{targetRunId}`, `restart_active{targetRunId}`, `queue_after_active`, and `start_immediately`, plus `deliveryIntent: auto|steer|restart` (`contracts/orchestrationV2.ts:3620-3637`). The client sends `start_immediately` with the user's intent, or `queue_after_active` (`cr/operations/commands.ts:884-909`).
- The server resolves the mode (`o2/CommandPolicy.ts:105-145`, `:206-244`):
  - No active run: start.
  - The run is preparing or starting, or has no running provider turn: queue.
  - Otherwise, if the provider `supportsActiveSteering`: steer. Else if it supports queued messages: queue. Else if it supports interrupt-restart: restart.
  - Slash commands and maintenance commands (compaction, `/logout`) never steer; they queue (`:117-120`, `:131-136`).
  - `decideSteeringExecution` returns `active_steering` or `interrupt_restart`, or a typed refusal (`:320-341`).
- Delivery: `ProviderTurnControlService.steer` checks that the recorded provider session, thread, and turn still match ("The recorded provider execution target is no longer valid") and that the turn is still running (`o2/ProviderTurnControlService.ts:129-217`, `:421-532`). A provider can report a steer as `pending` (queued natively until the agent reads it), `completed`, or `cancelled` (dropped unread) (`core/ProviderAdapter.ts:164-172`).
- Steer miss: if the turn completed first, or the provider declined the steer, the worker re-dispatches the same message id. It is queued if declined or automatic, otherwise started as a new turn, with `steerFollowUpOfRunId`. "Reuse message ids and receipts so retries cannot duplicate messages or follow-ups." (`o2/EffectWorker.ts:362-420`).
- Queue management commands are `queued-run.start|reorder|cancel|edit`, `queued-message.promote-to-steer`, and `queue.resume` (`contracts/orchestrationV2.ts:3686-3726`). Interrupting from the UI sets `holdQueue: true` (`cr/operations/commands.ts:1001-1007`). `isHeld` derives from `run.queueHeld` (`cr/state/threadWorkflows.ts:211`).
- UI: the queued-runs control has edit, reorder, cancel, and "steer now" (promote) with a shortcut label (`web/chat/QueuedRunsControl.tsx:115-211`, `:325-339`).

**Visible:**
- Before: a typed message shows as "queued" or is sent as a steer, depending on capability.
- During: queued items are listed with promote, edit, and cancel. A steer appears inline as a user message with `inputIntent: "steer"`.
- After: a steer that missed its turn reappears as the next queued or started turn.

**Durable:** messages, queued runs, and queue order are durable runs in the projection.

**Failure:** if the session is gone, the steer fails with "Provider session … is not active". A declined steer becomes a follow-up.

**Retry safety:** safe, because of message-id and receipt reuse.

**Authority:** the operate scope.

**Specific to local execution:** the steering semantics differ per native CLI, which is why the routing needs capabilities.

**Handoff today:** FeltKit agent control `signal`, then `submit` (taken at the next checkpoint), and `withdraw`. The instruction states are rendered (`handoff/src/AgentControl.tsx:69-82`, `:111-116`), and the runner declares `steer: next-step`.

**Judgments**
- **Handoff:** Handoff's signal/submit/withdraw sequence with checkpoint acknowledgement is *richer* than T3's steering: T3 has no "update coming" signal and no agent acknowledgement beyond pending, completed, or cancelled. Keep it.
- **Handoff, worth borrowing:**
  - (a) An explicit state for an instruction that missed the run, carried into the next attempt instead of dropped. T3's steer-miss fallback is the model; Handoff could carry undelivered instructions into the next attempt's snapshot.
  - (b) A queued-instruction list with edit, cancel, and reorder before delivery.
- **Platform (FeltKit agent control):** "instruction carried to next attempt" and a typed `cancelled-unread` state belong there.

---

## 6. Interrupt, stop, force stop, unresponsive

**Facts**
- `run.interrupt{runId, reason?, holdQueue?}`, `thread.stop{stopDelegatedTasks?}`, and `subagent.stop` (`contracts/orchestrationV2.ts:3294-3304`, `:3671-3685`).
- The client picks `thread.stop` when the environment advertises `capabilities.threadStop`, otherwise the active run's `run.interrupt`. That is server-capability gating on the client (`cr/operations/commands.ts:946-1007`).
- `ProviderTurnControlService.interrupt` (`o2/ProviderTurnControlService.ts:278-356`):
  - No live session: treat it as already stopped, logged, and do not fail the durable effect, "and retry 5x" (`:186-210`).
  - Subagents need `stopSubagent`, otherwise "The provider does not support stopping a native subagent." (`:295-312`).
  - It calls `interruptTurn({requestRuntimeRestart: true})` and waits up to 2 s for the turn to settle (`:313-341`).
- A timeout becomes `unresponsive`, which dispatches `thread.interrupt.unresponsive` instead of settling. "Settling here would end the run while the agent may still be running; the user decides with Force stop instead." (`o2/EffectWorker.ts:276-300`).
- Interrupting cancels the run's pending runtime requests as `not_resumable` (`o2/Orchestrator.ts:13289-13305`).
- Force stop is a separate RPC that kills processes. It requires `orchestration.operate` (`contracts/clientRpcPermissions.ts:92-93`).
- UI banner: "Agent not responding to Stop. It may be short on memory. Force stop kills its processes." with a [Force stop] button (`web/chat/ThreadActivityBanners.tsx:153-190`).

**Durable:** the interrupt request and `unresponsiveAt` are recorded (`o2/Orchestrator.ts:13586-13589`).

**Retry safety:** interrupt is idempotent and no live session counts as success. Force stop is destructive and is offered only after unresponsiveness.

**Specific to local execution:** process kill, and memory pressure on the user's machine.

**Handoff today:** Interrupt (cancel the current generation; a running tool finishes) and Stop (cooperative; also cancels the delegation, and only the delegator may) (`handoff/src/AgentControl.tsx:86-87`). The runner declares `stop: cooperative`.

**Judgments**
- **Handoff:** add the T3 "unresponsive" path. If a cooperative stop isn't acknowledged within N seconds or heartbeats, show "Agent not responding to Stop". The escalation is lease revocation or fencing (FeltKit invocation cancel plus a fenced claim), not a process kill. Handoff already has leases and fencing, so "force stop" equals "revoke the lease; any later report is refused".
- **Platform:** the stop-acknowledgement timeout and the unresponsive state belong in FeltKit agent control. Lease-based force stop is FeltKit invocation behavior.
- **Not applicable:** OS process kill.

---

## 7. Resume and continue

**Facts**
- `supportsNativeResume` (`contracts/orchestrationV2.ts:329-330`) and the optional adapter method `resumeTurn` (`core/ProviderAdapter.ts:808-810`). Without it the user sees `ProviderResumeUnsupportedError`: "Send a message to continue" (`core/ProviderAdapter.ts:326-333`; used in `o2/ProviderTurnStartService.ts:432`, `:1923`, `:2162`).
- Manual continuation sends `manualContinuationOfRunId` with the fallback text "Continue where you left off." (`cr/operations/commands.ts:778-779`, `:858-867`). Restart and usage-limit continuations have their own ids (`contracts/orchestrationV2.ts:3614-3619`).
- `canResumeAfterRestart?` keeps conversations alive when a provider cannot restore after restart (`core/ProviderAdapter.ts:767-768`).
- Queue hold and resume: `queue.resume` (`contracts/orchestrationV2.ts:3693-3697`).

**Judgments**
- **Handoff:** "Resume after interrupt" should read the declared `resume` capability. With `resume: none`, the UI should say "Send an update to continue" instead of showing a Resume button. That matches T3's error copy, turned into a disabled reason.
- **Not applicable:** pause. T3 has no agent pause; it only holds the queue. Handoff's `pause: between-steps` is beyond T3.

---

## 8. Model and runtime-mode switching, provider switching by handoff

**Facts**
- `applyModelSelection?` applies "where the provider can; otherwise it waits for the next turn" (`core/ProviderAdapter.ts:817-821`).
- A provider or instance change while a run is active is refused (`o2/Orchestrator.ts:4786-4795`).
- `supportsProviderSwitchingViaHandoff`, with context-handoff budgets (`contracts/orchestrationV2.ts:304`, `:395-404`), and `ContextHandoffService` building delta or full summaries (`o2/ContextHandoffService.ts`). The client gates the handoff UI with `threadSupportsProviderHandoff` (`cr/state/threadWorkflows.ts:133-151`).

**Judgments**
- **Handoff:** "Reassign to a different agent" for a delegation should carry a context handoff: the instructions, the timeline digest, and the branch state. It should be refused while an attempt holds the lease. That is T3's busy refusal.
- **Platform (EVE):** model switching inside a run.

---

## 9. Agent-to-agent: delegated tasks, subagents, child approvals

**Facts**
- T3 exposes its own MCP server to agents (`apps/server/src/mcp/*`).
- A child's runtime mode is never broader than its parent's. An inherited mode steps down to what the target provider supports, and an explicitly requested unsupported mode is refused (`apps/server/src/mcp/delegatedTaskModes.ts`, `resolveRuntimeMode`).
- `assertTargetWithinLimits` refuses an agent acting on a thread above its own mode, with this copy: "This call does not create an approval request. Have the user act directly in the target thread through an authorized client." (`apps/server/src/mcp/threadAccess.ts:175-189`). Full-access-only tools use `assertFullAccess` (`:218-221`).
- Agents may answer a child thread's **user-input questions** (`t3_pending_request`). They may **not** answer approvals: `readQuestion` filters to `kind === "user_input"` (`apps/server/src/mcp/toolkits/thread/handlers.ts:70-94`, `:248-285`).
- Child approvals are surfaced to the parent thread's UI for the human (`cr/state/threadRequests.ts:379-410`; `web/chat/ChildThreadApprovals.tsx:16-40`).
- `approvalsCanOriginateFromSubagents` is declared per provider (`contracts/orchestrationV2.ts:372`).

**Authority:** the agent's MCP token is scoped to its thread and capabilities and revoked per provider session or thread (`apps/server/src/mcp/McpSessionRegistry.ts`, interface around `:14-23`). Idle tokens expire after 24 h (`DEFAULT_LIVENESS_WINDOW_MS`).

**Judgments**
- **Handoff (important):** keep T3's rule. Agents may answer agents' questions but never approve consequential actions, and an agent can never raise another's autonomy. Handoff's "runner, other member, wrong digest" refusals already match.
- **Handoff:** roll child or sub-delegation approvals up to the parent delegation's page, as T3 does with `ChildThreadApprovals`.
- **Platform (FeltKit, AuthBoundry):** capping a sub-delegation's authority at its delegator's is an authorization concern.

---

## 10. MCP integrations

**Facts**
- `mcp-elicitation` is an approval kind (`contracts/providerPolicy.ts:53`). Codex full access still prompts for MCP elicitations (`o2/Adapters/CodexAdapterV2.ts:832-840`).
- `mcpApps` (interactive MCP app tools) and `mcpSignIn` are optional adapter capabilities (`core/ProviderAdapter.ts:704-757`, `:864-867`).
- MCP sign-in requires `providers.manage`, because "An MCP sign-in stores a credential for the agent" (`contracts/clientRpcPermissions.ts:21-23`). `mcpAppsCallTool` requires operate (`apps/server/src/auth/RpcAuthorization.ts:200`).

**Judgments**
- **Handoff:** the separation of *credential-granting* authority from *operate* authority is worth copying, for example connecting GitHub or a tracker versus steering.
- **Platform:** MCP server credentials for agents belong in AppPort Services or EVE.

---

## 11. Terminals

**Facts**
- User PTYs (`apps/server/src/terminal/Manager.ts:180-252`) support open, attach, write, resize, clear, close, `closeOnSettle`, and `hasActiveSubprocess`. History is bounded and persisted (`:1154`). Settling a thread refuses while a terminal subprocess is active and closes terminals on settle (`o2/ThreadSettlementService.ts:393`, `:421`, `:798`).
- ACP agents can request client-side terminals with caps: 16 live, 64 unreleased, 4 MB default output (`packages/provider-acp/src/server/clientTerminals.ts:1-7`).
- All terminal RPCs require `terminal.operate` (`apps/server/src/auth/RpcAuthorization.ts:216-222`). Saving workflow files requires the same scope ("saving it is running code there") (`contracts/clientRpcPermissions.ts:89-91`).

**Judgments**
- **Not applicable to Handoff** as an interactive terminal. Execution happens on runners.
- **Handoff:** the analogue is read-only streamed command output from the runner, which T3 also keeps transient: `command_output.delta` is unpersisted and the final output persists (`core/ProviderAdapter.ts:186-193`). Runner log streaming belongs in EVE or AppPort.

---

## 12. Authority model summary

**Facts:** client guards are "Incremental client enforcement; the server still authorizes every request" (`contracts/clientRpcPermissions.ts:18`). The server maps `dispatchCommand` to `orchestration.operate` (`apps/server/src/auth/RpcAuthorization.ts:46`). Approve, steer, interrupt, and mode change all go through `dispatchCommand`, so there is no per-command or per-approver distinction. Force stop is `orchestration.operate`, terminals are `terminal.operate`, and guest links and peer links are `access.write` (`contracts/clientRpcPermissions.ts:93-101`).

**Judgment:** T3 is single-owner. Its authority model is coarse by design. Handoff's person-scoped authority is the right model for multi-party work and should not regress to T3's: only the delegator stops or approves, and runners can't approve. Examples are `handoff/src/WorkDetail.tsx:69` and `handoff/src/AgentControl.tsx:87`.

---

## 13. Capability matrix: T3 compared with Handoff, and placement

| Capability | T3 (fact) | Handoff today (fact) | Recommended home (judgment) |
| --- | --- | --- | --- |
| Typed capability declaration | 12-group struct on the session, negotiated, server-routed (§1) | 6 flat enums, asserted, stored; **not consumed by the UI** (`AgentControl.tsx:58`) | Handoff: gate and explain controls. FeltKit or EVE: declare on the agent task and refuse on the server |
| Disabled-with-reason | Mode menu `disabledReason`; resume error copy | Only Stop has a reason (`AgentControl.tsx:87`) | Handoff |
| Permission or autonomy modes plus ceiling | 4 modes, managed ceiling (§2) | None; PR approval only | Handoff (product), FeltKit (ceiling) |
| Approval: record, then deliver, with delivery-failed state | Yes (§3) | FeltKit approval, then a runner resume attempt | FeltKit invocation approval |
| `not_resumable{reason}` stale approvals | Yes | Unknown or implicit | FeltKit |
| Approval scope once or session | Yes (ephemeral) | Once, digest-bound | Keep once; FeltKit if extended |
| Named approver, digest, expiry | No (any operator; no timeout) | **Yes** | Already Handoff and FeltKit |
| Decline with feedback to agent | Yes, live approvals only | Reject has a reason; not routed to the agent | Handoff and FeltKit |
| Steer: active, restart, or queue routing | Yes | next-step steer through agent control | FeltKit agent control |
| Signal "update coming" and acknowledgement | No | **Yes** | Keep |
| Steer-miss carried forward | Yes, idempotent | Not observed | FeltKit agent control |
| Queue edit, reorder, cancel, promote | Yes | No | Handoff UI over FeltKit instructions |
| Pause between steps | No (queue hold only) | **Yes** | Keep |
| Interrupt with typed unsupported or timeout | Yes, 2 s then unresponsive | Interrupt button always enabled | FeltKit (ack timeout), Handoff (UI) |
| Force stop | Process kill after unresponsive | Stop also cancels the delegation | Handoff: lease revoke and fence (FeltKit invocation) |
| Resume or continue | Native resume or "send a message" | Resume button | Handoff: gate on `resume` |
| Agent answers agent questions, never approvals | Yes | Runner can't approve | Keep; AuthBoundry for sub-delegation caps |
| Child approvals rolled up to parent | Yes | N/A yet | Handoff |
| MCP credential vs operate authority split | Yes | N/A | AppPort Services, AuthBoundry |
| Terminals | PTY plus ACP client terminals | N/A | Not applicable; log streaming in EVE or AppPort |
