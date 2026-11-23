# T3 Code evidence C: workspace, worktrees, checkpoints, diffs, source control, scheduling

Read-only audit of `/home/user/rkendel1/t3code` (no files changed, nothing installed), done 2026-11-23.
T3 is used here as a product and interaction reference, not as code to port.

- **Server paths** are relative to `apps/server/src/` unless they are written in full.
- **Web paths** are relative to `apps/web/src/`.
- **Handoff paths** are relative to `/home/user/handoff/`.

Each capability has two parts:

- **Facts** are what the code does, with `file:line` references.
- **Judgments** are labelled **J:**, and say what Handoff should take from it.

The "Where it belongs" column uses these values: **Handoff**, **FeltKit**, another platform repo, or **N/A** (specific to T3's local-execution model).

---

## 0. Key findings in brief

1. **T3 treats git and the host as authoritative. Its own database records only links and snapshots.**
   - Git status, branches and ahead/behind counts are read live from `git` and cached for 1 s (`git/GitManager.ts:225`).
   - PR state is read from GitHub through GraphQL and REST, then cached:
     - 60 s for an open PR (`git/GitManager.ts:227`);
     - 5 min for "no open PR" (`git/GitManager.ts:228`);
     - after a failure, a back-off that starts at 20 s and caps at 15 min (`git/GitManager.ts:229-230`, `:248`).
   - A thread stores a `ThreadPullRequestLink` with a `snapshot` (`packages/contracts/src/threadPullRequest.ts:134-147`). The snapshot is a dated copy of the host's state, and `observedAt` sits on the summaries (`packages/contracts/src/pullRequest.ts:533`, `:675`).
   - This is the same stance as Handoff's dated "facts".
2. **Opening a PR is reconcile-first, with no idempotency key.**
   - Before it POSTs, `openPrFromBranch` looks up an **open** PR for the head and returns `opened_existing` if one exists (`git/GitManager.ts:2745-2756`).
   - The create call is a plain REST `POST repos/{o}/{r}/pulls` (`packages/source-control-github/src/server/GitHubSourceControlProvider.ts:1121-1149`).
   - After the create, a failed lookup is logged, and the result is `created` without a URL (`git/GitManager.ts:2816-2832`).
   - A draft conversion that fails is reported as an error. The comment says "A retry finds the open PR and drafts it then" (`git/GitManager.ts:3081-3090`).
   - T3 has no "unknown outcome" state. Handoff's `unknown_write` fact plus read-verify (`feltkit/github.ts:142-157`) is **stronger** than T3's handling.
3. **Authority comes from the person's own ambient credentials.**
   - Pushes use the local `git` credential helper (`vcs/GitVcsDriverCore.ts:3770`, `:3887`, `:3902`).
   - PR writes use a GitHub token resolved in this order: a token saved in Settings, then a GitHub App token, then `GH_TOKEN`/`GITHUB_TOKEN`, then the `gh` login (`packages/source-control-github/src/server/GitHubCredentials.ts:37`, `:108`, `:212`, `:250`, `:281`).
   - Agents get the same authority through MCP (`mcp/toolkits/pullRequests/tools.ts:680-702`, `pull_request_create`, annotated `Idempotent: true`). Agents can also run `gh pr create` in a shell; T3 detects that command and links the PR afterwards (`orchestration-v2/PullRequestSyncReactor.ts:58-75`).
   - T3 has **no** per-PR human approval gate comparable to Handoff's. **J:** this is the biggest model difference. Handoff should not copy it.
4. **Diffs come at four scopes, all computed from git.**
   - **Per turn:** checkpoint refs under `refs/t3/orchestration-v2/checkpoints` (`orchestration-v2/CheckpointService.ts:35`).
   - **Branch "Changes"** against the base.
   - **Uncommitted.**
   - **A single commit.**
   - The scope union is in `diffPanelStore.ts:17-31` and the scope menu in `components/DiffPanel.tsx:1022-1075`. The UI shows a file tree, `components/diffs/DiffFileTree.tsx`, and a code view, `components/diffs/StyledDiffCodeView.tsx`.
   - An inline "changed files" card follows each assistant turn (`components/chat/ChangedFilesTree.tsx`, used at `components/chat/TimelineAssistantRows.tsx:531`).
5. **PR, check and review state is a typed, dated read model that separates "unknown" from "none".**
   - Fields include `mergeability: mergeable|conflicting|unknown`, `reviewDecision`, `checksState`, and checks with a `required` flag and a `placeholder` flag for checks that could not be read (`packages/contracts/src/pullRequest.ts:27-31`, `:52-56`, `:114-126`).
   - Fields marked "Absent means ... not that it is off" are documented as unknown rather than false (`:543`, `:685`).
   - A review given before the newest commit is shown as **stale** (`components/pullRequest/pullRequestDetail.logic.ts:479`; labels at `components/pullRequest/pullRequestPresentation.tsx:331-363`).
6. **A merge is pinned to a head SHA.** A merge with `expectedHeadSha` re-reads the PR and refuses with "The head is now X, not Y. Review the new commits first." (`pullRequest/PullRequestService.ts:2318-2343`). The agent's merge tool requires `expectedHeadSha` (`mcp/toolkits/pullRequests/tools.ts:788-795`).
7. **Scheduling and background work are local and in-process.**
   - A 5 s ticker drives the scheduler (`scheduling/Scheduler.ts`).
   - A fixed-time run that is missed by more than 10 min is skipped and recorded as failed (`scheduledTasks/Schedule.ts:73-82`, `scheduledTasks/ScheduledTaskService.ts:1337-1350`).
   - Runs that crashed are marked failed at startup (`scheduledTasks/ScheduledTaskService.ts:1360-1375`).
   - The host is kept awake with `caffeinate` or `systemd-inhibit` (`background/KeepAwake.ts:59`, `:64`).
   - **J:** most of this is N/A for Handoff, which already uses FeltKit jobs.

---

## 1. Workspace and project selection

| | Facts |
|---|---|
| User problem | Pick or add a repository (local folder or clone URL) to work in. |
| Action and transition | `ProjectService.create` and `bootstrap` (`project/ProjectService.ts:150-157`). Cloning by URL goes through `ProjectCloneTracker.start`, `cancel`, `retry` and `discard`, and streams snapshots (`project/ProjectCloneTracker.ts:39-52`). The repository identity is resolved from the remotes (`project/RepositoryIdentityResolver.ts`). |
| Visible | `components/AddProjectToMachineDialog.tsx`, `components/ProjectCloneToastCoordinator.tsx` (clone progress toast), `components/CommandPaletteAddProject.tsx`. |
| Durable or transient | Projects are durable (SQLite projection). Clone progress is in memory, and the clone is retryable. |
| On failure | A failed clone can be retried with `retry` or discarded with `discard` (`:48-50`). |
| Authority | The user's local git credentials. |
| Specific to local execution | Folders on the person's disk, plus "managed project folders" (`project/ManagedProjectFolders.ts`). |
| Handoff today | Repositories are registered by an admin (`feltkit/admin.ts`). The runner clones outside the sandbox. |
| Where it belongs | **J:** Handoff already covers registration. A clone-progress or retry UI is N/A, because the runner clones. Capturing repository identity from the remote (host/owner/name) is worth keeping in Handoff, and Handoff already stores owner and name. |

## 2. Worktrees (one isolated checkout per thread)

| | Facts |
|---|---|
| User problem | Run agents in parallel without them writing into each other's working tree. |
| Action and transition | The launch strategy is `root`, `existing_worktree` or `worktree{baseRef, branch?, startFromOrigin?, repositories?}` (`packages/contracts/src/orchestrationV2.ts:782-806`). The launch creates a temporary branch name and then asks a model for a real name in parallel (`orchestration-v2/ThreadLaunchService.ts:641-679`). It creates the worktree (`:820-840`), and a missing base ref fails with `ThreadLaunchBaseRefError` (`:833-840`). A worktree that was deleted is recreated (`workspace/restoreMissingWorktree.ts:154-175`). The thread's working directory is `worktreePath ?? project.workspaceRoot` (`project/threadWorkspaceRoot.ts`). |
| Visible | The env-mode selector offers Local or Worktree, and says "Each model starts in its own worktree" (`components/BranchToolbarEnvModeSelector.tsx:61-102`). Other pieces: the base-branch picker (`components/WorktreeBaseBranchPicker.tsx`), the per-thread setup card with stages `fetch`, `checkout`, `submodules`, `setup-script`, `agent` and statuses `pending`, `running`, `done`, `skipped`, `warning`, `failed` (`packages/contracts/src/worktreeSetup.ts:13-56`; `components/chat/WorktreeSetupCard.tsx:114-122`, "Worktree ready, setup script failed" or "Worktree setup failed"). |
| Durable or transient | The worktree path is on the thread (durable). Setup progress is in memory only (`project/WorktreeSetupTracker.ts:97-104`). |
| On failure | A failed setup script gives `warning` or `failed` but the worktree remains usable. A checkout that another active thread is using is refused with "... still working in this checkout. Wait ... or use a worktree" (`git/sharedCheckoutGuard.ts:13-35`). Deleting an orphaned worktree is offered only when no other thread shares it (`worktreeCleanup.ts:1-30`). |
| Authority | Local git. |
| Specific to local execution | Everything. The worktrees live on the person's machine. |
| Handoff today | One branch per generation, `handoff/d{n}-g{g}` (`feltkit/_lib.ts:63`). The runner gets a fresh clone and sandbox for each attempt. |
| Where it belongs | **J:** isolation already comes from EVE and runner sandboxes (platform), so worktrees are N/A. The **staged setup progress** (fetch, checkout, setup script, agent, with warning distinct from failed) is a good model for a runner "preparing" phase. Runners would report it, and Handoff shows it as a transient observation, not a fact. The protocol belongs in Handoff and the progress transport in FeltKit (agent-control events). |

## 3. Checkpoints (per-turn snapshots) and rewind

| | Facts |
|---|---|
| User problem | See what each turn changed, and undo a turn's file changes along with its conversation. |
| Action and transition | After each run, `CheckpointCaptureService` captures a checkpoint for every scope: the root folder plus each tracked repository. It materializes baselines when they are missing, and each scope is checked separately, so a retried capture fills only what is missing (`orchestration-v2/CheckpointCaptureService.ts:111-175`). A checkpoint is a git ref under `refs/t3/orchestration-v2/checkpoints/<scopeHash>/ordinal/<n>` (`orchestration-v2/CheckpointService.ts:35`, `:282-293`). A capture skips repositories the run did not touch ("costs one status and writes nothing", `:227-247`). Restore is all-or-nothing across folders: each folder is snapshotted first, and a failure puts back the folders already restored (`:250-263`, `:821-900`). Rollback refuses a shared workspace (`orchestration-v2/CheckpointRollbackService.ts:337`), with the message in `orchestration-v2/CheckpointRestoreSafety.ts:19-20`. A conversation-only rewind is allowed with `restoreFiles: false`. |
| Visible | Turn rewind: the web refuses while a turn is running ("Interrupt the current turn before reverting checkpoints"). It asks for confirmation that names restoreFiles, then shows "Rewinding conversation" (`components/chat/useTimelineRewind.ts:95-180`; `components/ChatView.tsx:3870`). "Fork from run" creates a new thread from a run (`components/chat/useTimelineRewind.ts:186-200`). |
| Durable or transient | Durable: the refs live in the repository, and the checkpoint records live in the projection. |
| On failure | A locked git index maps to a specific retryable error (`orchestration-v2/CheckpointRollbackService.ts:93-95`). A capture timeout is counted, and later baselines get a time budget (`orchestration-v2/CheckpointService.ts:411-430`). |
| What can be retried | Capture (idempotent per scope). Rollback is all-or-nothing. |
| Specific to local execution | Rewinding files in a live working tree that the person also edits. |
| Handoff today | None. Work is accepted, returned (new generation and new branch) or rejected. |
| Where it belongs | **J:** file rewind is **N/A**, because GitHub branches are the record and the runner's checkout is disposable. Two things do transfer: (a) **per-turn or per-checkpoint diff attribution**, if runners push one commit per agent checkpoint, or report the SHA at each `feltkit_agent_checkpoint`, so Handoff can show "what changed since the last steer"; (b) **fork from a point**, which in Handoff is "return work, starting from commit X", already close to `returned` with a new generation. Handoff owns this. |

## 4. Diffs (per turn, whole thread, branch, uncommitted, commit; file tree; rendering)

| | Facts |
|---|---|
| User problem | Review what the agent changed, at the right granularity. |
| Server | `CheckpointDiffQuery.getTurnDiff` and `getFullThreadDiff` diff two checkpoint refs (`checkpointing/CheckpointDiffQuery.ts:64-70`, `:254`). Pathspecs are batched under the Windows command-line limit (`:39-49`), up to 6 repositories run concurrently (`:40`), and output is capped at `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000` (`vcs/VcsDriver.ts:43`) with a truncation marker (`checkpointing/CheckpointDiffQuery.ts:1`, `:368`, `:430`). |
| Visible | Scopes are `branch` ("Changes"), `unstaged` ("Uncommitted"), `latest` turn, `Turn N` with completion time, `commit <sha>` with a link to the host, and `tool-call` (`diffPanelStore.ts:17-31`; `components/DiffPanel.tsx:340-440`, `:1000-1075`). Each turn's inline "Changed files" card is grouped by repository, with totals (`components/chat/ChangedFilesTree.tsx:20-30`). The diff panel has a file tree (`components/diffs/DiffFileTree.tsx`, `diffFileTree.logic.ts`), per-file status (`components/diffs/DiffFileStatus.tsx`), line annotations and comments (`components/diffs/AnnotatableCodeView.tsx`, `components/diffs/DiffCommentAnnotation.tsx`), a hide-tests toggle (`components/diffs/useHideTestFiles.ts`), lazy per-file loading (`components/diffs/DiffFileLoadingBoundary.tsx`) and a worker pool (`components/DiffWorkerPoolProvider.tsx`). The PR "Code" tab has viewed-file tracking (`components/pullRequest/PullRequestCodeTab.tsx`, `pullRequest/pullRequestViewedFiles.ts`). |
| Durable or transient | Diffs are computed on demand. Viewed-file state persists on the server (`pullRequest/pullRequestViewedFiles.ts`). |
| On failure | `PullRequestDiffUnavailableState.tsx` and `pullRequestDiffError.ts` show an explicit "unavailable" state, not an empty diff. |
| Handoff today | The `diff` fact holds base...head files with patches, capped at 4 KB per file and 60 KB in total, plus a `truncated` flag (`feltkit/github.ts:42-63`). It is rendered as a flat list with +/- colouring and "open the PR for the full diff" (`src/WorkDetail.tsx:122-129`). |
| Where it belongs | **J (Handoff):** (a) add a **file tree with per-file +/− counts and status** above the patches. Handoff already has additions, deletions and status per file. (b) Add **diff scopes per generation**: "this generation" (previous generation's head → head) beside "whole delegation" (base → head). The data is the GitHub compare API, which Handoff already uses. (c) Add **"since my last review or steer"** when a head SHA was recorded at the steer. (d) Keep the explicit "unavailable" and "truncated" states. **J (platform):** a reusable diff viewer component could belong in a FeltKit UI kit if one exists. Otherwise Handoff owns it. |

## 5. Branches, commits and push (local)

| | Facts |
|---|---|
| User problem | Commit the agent's work, push it, then open a PR, in one gesture. |
| Action and transition | `runStackedAction` runs the phases branch → commit → push → pr in order, emitting `action_started`, `phase_started`, `hook_started`, `hook_output`, `hook_finished`, `action_finished` and `action_failed{phase}` (`git/GitManager.ts:4054-4280`). Commit and branch names can be generated by a model (`:2493`, `:4017-4050`). The commit timeout is 10 min (`:221`). "Nothing to commit" gives `skipped_no_changes` (`:2595`, `:2659`). It refuses to push or open a PR from detached HEAD (`:4090-4110`). It refuses to open a PR whose head is the base branch (`:2678-2704`). Push is plain `git push -- <remote> HEAD:refs/heads/<branch>`, with **no force** in the normal flow (`vcs/GitVcsDriverCore.ts:3770`, `:3887`, `:3902`). Status is invalidated whatever the outcome (`git/GitManager.ts:4255`). |
| Visible | The menu disables an action and gives a precise reason: "Worktree is clean...", "Detached HEAD...", "Branch is behind upstream. Pull/rebase...", "No local commits to push", "Add an origin remote" (`components/GitActionsControl.logic.ts:124-290`). A confirmation appears before acting on the default branch, with an option to create a feature branch (`:491-545`). Progress and hook output stream in. A failure shows an "Action failed" toast with the server message, and the typed commit message is kept for a retry (`components/GitActionsControl.tsx:1259-1275`, `:1306-1310`). A success shows inline text such as "Created PR" (`:1278-1291`). |
| Durable or transient | The git effects are durable in git. Progress is transient. |
| What can be retried | Every phase is re-entrant against git state: a commit with nothing staged is skipped, a push with nothing ahead is skipped, and the PR step finds the open PR. |
| Authority | The person's local git credentials. Pre-commit hooks run locally. |
| Handoff today | The runner commits and pushes outside EVE. Handoff records `commits` facts from GitHub (`feltkit/github.ts:68`). |
| Where it belongs | **J:** the commit and push UI is N/A, because the runner does it. Two things transfer: (a) **reasons for each disabled state**, in Handoff's approval UI. If "Approve PR" cannot be pressed, say why: no pushed head, head differs from the report, branch behind base, and so on. (b) **Hook and CI-like output during the runner's commit**, as transient runner events (FeltKit agent-control events). |

## 6. Opening pull requests: failure handling and idempotency

Facts:

- **Entry points:**
  - the UI's `runStackedAction`, which calls `runPrStep` and then `openPrFromBranch`;
  - an explicit `createPullRequest` (`git/GitManager.ts:3073-3093`);
  - the agent MCP tool `pull_request_create` (`mcp/toolkits/pullRequests/tools.ts:680-702`);
  - agent shell `gh pr create`, which is detected and linked afterwards (`orchestration-v2/PullRequestSyncReactor.ts:58-75`).
- **Order in `openPrFromBranch`** (`git/GitManager.ts:2706-2840`):
  1. Require a branch and an upstream: "Current branch has not been pushed. Push before creating a PR."
  2. Resolve the head context, including fork and cross-repository cases.
  3. **`findOpenPr`, and if a PR is found, return `opened_existing`.**
  4. Refuse if commits are unpushed: "The branch has N unpushed commits."
  5. Resolve the base.
  6. Generate the title and body. The model sees the diff, commits, the repository's PR template and thread context (`:2860-2890`).
  7. Write the body to a temp file.
  8. POST.
  9. Re-run `findOpenPr` for the number and URL. If that lookup fails, return `created` without a URL (`:2816-2832`).
- **Create call.** It is a REST POST with `maintainer_can_modify: true` and an optional draft flag. It sends **no idempotency header** (`packages/source-control-github/src/server/GitHubSourceControlProvider.ts:1121-1149`).
- **Duplicate PR error.** If GitHub returns 422 "A pull request already exists", T3 has no special handling (grep finds none). A retry falls into step 3 and adopts the PR.
- **Drafts.** A draft that cannot be applied fails with "Opened the pull request, but the host does not list it yet to make it a draft". A retry finds the open PR and converts it (`git/GitManager.ts:3081-3125`).
- **Private PRs.** The branch is pushed to a companion private remote, and the push remote is recorded **before** the push so that a later push never publishes the branch (`git/GitManager.ts:2894-3014`).
- **Linking.** `linkCreatedPullRequest` attaches the PR to the thread. It never fails, and a link that cannot be made is logged and dropped (`git/linkCreatedPullRequest.ts:46-60`).
- **UI.** On success it shows "Created PR" (`components/GitActionsControl.tsx:1281-1287`). On failure it shows a toast with the server detail.

Judgments:

- **J:** Handoff's design is already stricter than T3's on every axis. It has an approval gate on the exact branch and head, reconcile-first, an idempotency key per generation, and an `unknown_write` fact plus read-verify (`feltkit/github.ts:114-160`).
- **J: gap to check in Handoff.** `observe()` lists pull requests with `state: "all"` and adopts the **lowest-numbered** PR on the branch (`feltkit/github.ts:28-29`). If a person closed that PR, reconciliation returns `created:false` with a **closed** PR and never opens a new one. T3 reconciles only against **open** PRs (`findOpenPr`). Branches are per generation, so this is rare. Handoff should still decide this explicitly: adopt an open PR; if the PR is merged, report that; if it is closed, say so and require a new approval or a new generation. The decision belongs in Handoff.
- **J:** worth taking from T3:
  - the explicit precondition errors ("not pushed", "N unpushed commits", "head is the base branch");
  - generating the PR body from the repository's PR template;
  - for Handoff, checking **head SHA == approved SHA on GitHub** before create, which Handoff partly does already through the approval input.

## 7. PR, check, review and merge status (read model and display)

| | Facts |
|---|---|
| Model | `PullRequestSummary` and `PullRequestDetail` (`packages/contracts/src/pullRequest.ts:519-545`, `:649-695`) carry state, isDraft, mergeability, rebaseRequired, baseComparison and behindBy, reviewDecision, checksState, checks[] with `required` and `placeholder`, autoMerge, a merge queue removal and `observedAt`. Check status has 7 values: pending, action-required, success, failure, skipped, neutral, cancelled (`:101-110`). The GitHub read is one GraphQL query that includes `statusCheckRollup` with **both CheckRuns and StatusContexts**, plus `isRequired`, `mergeable`, `mergeStateStatus` and `reviewDecision` (`packages/source-control-github/src/server/pullRequestReads.graphql.ts:571-574`). |
| Freshness | The PR read cache is persisted with revisions (`pullRequest/PullRequestReadCache.ts`). A sync sweep runs, with a quiet cadence of 5 min after 30 min without updates, a slow cadence of 15 min, closed PRs dropped after 24 h, and failure back-off starting at 60 s and doubling (`orchestration-v2/PullRequestSyncReactor.ts:46-56`). Branch status lookup has its own TTLs (`git/GitManager.ts:227-235`). |
| Visible | Per-thread PR panel row: state and draft, conflict badge, checks glyph, review-decision glyph, "watching" eye (`components/pullRequest/ThreadPullRequestsPanel.tsx:170-235`). The checks popover loads on open, with "Loading checks…", "No checks reported" or the error text (`components/pullRequest/PullRequestChecksPopover.tsx:15-45`). In the detail panel, checks are marked **stale** when the summary's checksState differs from the detail's, and stale checks are hidden (`components/pullRequest/PullRequestDetailPanel.tsx:1353`, `:1415`, `:1486`). Review verdicts given before the newest commit are shown faded, as "Approved earlier changes" (`components/pullRequest/pullRequestDetail.logic.ts:479`; `components/pullRequest/pullRequestPresentation.tsx:331-392`). The merge-conflict badge shows only for open, non-draft, conflicting PRs (`:141-150`). The detail panel also has tabs for summary, timeline, code and guide (`components/pullRequest/PullRequestDetailPanel.tsx`). |
| Watching | An agent or person "watches" a PR. A sweep runs every 2 min (`orchestration-v2/PullRequestWatchReactor.ts:58`) and wakes the agent on: checks failed, checks passed (required), checks finished, awaiting approval, new remarks, no checks within 15 min, conflicting, needs rebase, or removed from the merge queue (`orchestration-v2/pullRequestWatch.ts:12-30`). A first-read **baseline** keeps old failures from being reported as new, and a pushed head resets check state (`:60-80`, `packages/contracts/src/threadPullRequest.ts:84-128`). Comment-only wakes stop after 10 (bot-loop guard, `orchestration-v2/pullRequestWatch.ts:10`). Placeholder checks never count as passing (`:88-90`). |
| Actions | merge, ready, draft, close, reopen, delete-branch, update-branch, enable or disable auto-merge, revert, approve-workflows (`packages/contracts/src/pullRequest.ts:67-79`). A merge is pinned to `expectedHeadSha` (`pullRequest/PullRequestService.ts:2318-2343`). |
| On failure | `PullRequestActivityUnavailableState.tsx` and `PullRequestsUnavailableState.tsx` show explicit unavailable states. A read failure keeps the previous check state ("Hosts can return no checks on read failure; preserve prior state", `orchestration-v2/pullRequestWatch.ts:80`). |
| Authority | The same credential chain as §0.3. GitHub App access is surfaced in `components/SourceControlAppAccessNotice.tsx`. |
| Handoff today | `checks` facts from **check-runs only** (`feltkit/github.ts:70-74`). `reviews` facts with the latest state, worst first (`:75-80`). A dated "observed X ago" on each (`src/WorkDetail.tsx:113-119`). Verification compares the PR head with the reported head (`feltkit/github.ts:181-195`). |
| Where it belongs | **J (Handoff), in priority order:**<br>1. Treat **review staleness** properly. Compute each review's `commit_id` against the current head and show "approved an earlier head". Today an APPROVED review on an old head reads as approved.<br>2. Add **commit statuses** (the legacy status API) or use GraphQL `statusCheckRollup`. Today a repository that uses StatusContexts shows "none".<br>3. Record **required vs optional** checks and the PR's **mergeability, draft and behind-base** state as facts.<br>4. Show **unknown** separately from **none**: a failed read keeps the previous fact and marks freshness. Handoff's sync state already records `lastError`.<br>5. When Handoff later gains merge, pin it to the verified head SHA.<br>**J (platform):** GitHub webhooks would replace polling, but AppPort Services inbound blocks them (Handoff report). That is AppPort Services work. |

## 8. Scheduling and background execution

| | Facts |
|---|---|
| User problem | Run an agent prompt on a schedule (once, at an interval, at a fixed time on chosen weekdays) or from a webhook. Keep long work running while the machine would otherwise sleep. |
| Action and transition | `ScheduledTaskService` stores tasks in SQLite (`scheduledTasks/ScheduledTaskService.ts:410-430`, `:692-701`). A run launches a new thread with the task's workspace strategy, which can be a worktree (`:1120-1140`), or sends into a bound thread. `runNow` exists (`:287`). An overlapping manual run fails with "already running" (`:1255-1257`). The next run is computed by `nextScheduledRunAt`, with a minimum interval (`scheduledTasks/Schedule.ts:11-46`). A fixed-time run missed by more than 10 min is **skipped**, not caught up, and recorded as failed: "Missed a scheduled run because the server was not running at that time." (`scheduledTasks/Schedule.ts:73-82`; `scheduledTasks/ScheduledTaskService.ts:1340-1347`). A failure between markRunning and markCompleted still advances `next_run_at` and records failure (`:820-850`). `running` rows left by a crash are marked "Run was interrupted by a server restart." (`:1360-1375`). Updates use compare-and-set on `next_run_at` and `last_run_at` (`:1296-1300`). Webhook triggers have verification, filters, de-duplication, a queue of at most 20 per task and 60 per minute (`:83-103`, `scheduledTasks/webhookDedupe.ts`). The scheduler ticks every 5 s and allows one in-flight run per source (`scheduling/Scheduler.ts`). |
| Background | `BackgroundPolicy` runs scope work only while clients hold activity leases (45 s TTL, at most 120 s; `background/BackgroundPolicy.ts:42-44`). `KeepAwake` uses `caffeinate` or `systemd-inhibit` (`background/KeepAwake.ts:59-70`). On restart, background work that was cancelled is reported to the agent (`packages/contracts/src/orchestrationV2.ts:765-780`; `orchestration-v2/RestartBackgroundNote.ts`). |
| Durable or transient | Tasks and the last run's status and error are durable. Activity leases are transient. |
| Handoff today | FeltKit jobs with `runAt` run the GitHub sync, with chain de-duplication and back-off (`feltkit/github.ts:200-221`). There is no user-scheduled delegation. |
| Where it belongs | **J:** keep-awake and client leases are **N/A**, because they are an artifact of a local host. Recurring delegation, such as "every Monday, update dependencies", is a possible future Handoff feature on FeltKit jobs. Two of T3's semantics should be copied if Handoff builds it: **a missed fixed-time run is skipped and recorded, not silently caught up**, and **an interrupted run becomes a terminal failed record**. Inbound webhook triggers depend on AppPort Services inbound, which is the platform. |

## 9. Is git or GitHub authoritative?

- **Facts.**
  - Branch status, ahead/behind and working-tree changes are read from git each time, with a 1 s cache (`git/GitManager.ts:225`, `:1294-1330`).
  - PR state is read from the host, and the thread link holds only a snapshot with `observedAt`.
  - A PR lookup that fails backs off rather than reporting "no PR" (`git/GitManager.ts:244-252`, `:1424-1437`).
  - T3 remembers a "last known PR" per branch so the UI does not flicker during failures (`git/GitManager.ts:1525-1560`).
- **J:** this matches Handoff's facts model. One detail to borrow: **last-known plus a freshness marker during read failures**, instead of blanking the panel. Handoff's `WorkDetail` already keeps the latest fact. It should also show `sync.lastError` and `lastOkAt` next to the GitHub section.

## 10. Summary table

| Capability | Handoff has it? | Belongs in |
|---|---|---|
| Project add or clone | Partly (admin registration) | Handoff (done); clone UI N/A |
| Worktrees per thread | Equivalent through sandbox and branch per generation | N/A (EVE/runner) |
| Staged setup progress | No | Handoff UI + FeltKit agent-control events |
| Per-turn checkpoints and file rewind | No | N/A (rewind); Handoff for per-checkpoint SHA and diff |
| Diff scopes (turn, generation, whole) | Whole branch only | Handoff |
| Changed-file tree with counts | Flat list | Handoff |
| Commit and push UI | Runner does it | N/A |
| Reasons for disabled actions | Partial | Handoff |
| Reconcile-first PR create | Yes (stronger: approval, idempotency key, unknown-verify) | Handoff (done); fix the closed-PR adoption case |
| PR body from template, diff and context | No (runner supplies the body) | Runner/Handoff |
| Checks incl. StatusContexts and required flag | Check-runs only | Handoff |
| Review staleness against head | No | Handoff |
| Mergeability, draft, behind-base | No | Handoff |
| Merge pinned to head SHA | No merge yet | Handoff (when added) |
| PR watch and agent wake-ups | Polling for verification only | Handoff (wake runner via steer) + FeltKit jobs |
| GitHub webhooks | Blocked | AppPort Services |
| Scheduled or recurring delegations | No | Handoff on FeltKit jobs (future) |
| Keep-awake and client leases | No | N/A |
| Ambient user credentials and agent-created PRs | Deliberately not | N/A (Handoff keeps approval-gated, Handoff-opened PRs) |
