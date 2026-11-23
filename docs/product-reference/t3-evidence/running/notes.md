# T3 Code: running-behavior evidence (notes)

Captured 2026-11-23 from a scratch copy of `/home/user/rkendel1/t3code`. No tracked files in the original repo were modified. Screenshots are 1440x900 at deviceScaleFactor 1, Chromium through Playwright, light theme.

## What was run

- Scratch checkout: `/tmp/claude-0/-home-user/4a03c94e-9ebd-5764-a1e2-9dcd3d7ea003/scratchpad/t3run`. A previous run had already installed it with pnpm 12.14.0, and this run reused that install.
- Runtime: Node 24.22.3. The repo pins `engines.node` to 26.13.1, but the dev server ran on 24 without problems.
- Dev server command, run from t3run:
  `PATH=$PWD/node_modules/.bin:<node24>/bin:$PATH T3CODE_HOME=<scratch>/t3home node scripts/dev-runner.ts dev`
  - The server listens on `127.0.0.1:13773` and the web app (Vite+) on `localhost:5733`.
  - The first attempt failed with `DevRunnerProcessError ... spawn vp ENOENT`, because `node_modules/.bin` was not on PATH. Adding it fixed the start.
  - On startup the server logs `Authentication required. Open T3 Code using the pairing URL` with `pairingUrl: http://localhost:5733/pair#token=...`. The persistent Playwright profile from the previous run still held a valid session, so this run did not need to pair again.
- Fake provider: the **"Replay (dev)"** provider, instance `devReplay` (ACP registry driver).
  - Dev servers seed it automatically (`apps/server/src/provider/ProviderInstanceRegistryHydration.ts`, `seedDevReplayInstance`). It runs `apps/server/scripts/dev-replay-agent.ts`, which replays recorded ACP transcripts with simulated streaming.
  - Each scenario appears as a "model": Showcase, Plan and reads, Write approval, Question, Multi turn, Command output.
  - The real adapter, orchestration, approvals and UI all run. The agent does not change files.
  - The web app exposes `window.t3dev.replay(scenario)` (`apps/web/src/components/DevReplayHost.tsx`) as a shortcut. It was used once (Showcase); the other turns were started through the normal composer and model picker.
- Projects:
  - **server**: the auto-registered dev project at `t3run/apps/server`. Its source-control panel shows `+0 -4,051,886`, an artifact of the scratch copy's git state, not of anything the turn did.
  - **demo-app**: the previous run's local-folder picker created this project at `/root/tmp/claude-0/.../scratchpad/demo-app`, not at the typed `/tmp/...` path. The typed path seems to have been treated as relative to `~`, but the cause was not investigated. The folder was empty, which is why 05 shows "Initialize Git". In this run I copied a tiny git repo (`src/math.ts` plus a `sub()` change, README) into that folder so the diff and source-control panels had real content.
- Drove the UI with Playwright scripts in `<scratch>/pw/` (`run.js` + step files).
- Disconnect test: I stopped the server process (SIGTERM) while a thread was open.
- Cleanup: I stopped the whole dev-runner process group, including Vite, the server, the replay agents and t3-resource-monitor. Ports 13773 and 5733 were verified closed.

## Important caveat: real credentials were used for thread titles

This VM has a preinstalled Claude CLI (`/opt/node22/bin/claude`). T3 Code detected it as authenticated (Settings > Providers: "Claude v2.1.330, Authenticated · Claude Api Subscription").

No turns were sent to Claude. However, the server **automatically used it to generate thread titles** for the replay threads. The server trace shows two successful `ClaudeTextGeneration.generateThreadTitle` spans, which produced the titles "Update Project README" and "Choosing a Test Framework". No text generator was configured, so T3 Code fell back to an available provider.

So two small title-generation calls went to a real provider despite the no-credentials intent. No further threads were created after I found this. Future runs should disable the Claude provider, or set `PATH`/`HOME` so the CLI is not found, before starting any turn.

## Worked / failed

| Item | Result |
|---|---|
| Dev server + web from source | Worked after adding `node_modules/.bin` to PATH |
| Codex provider | Failed as expected: no `codex` binary. Error: "Could not start Codex CLI (`codex`). Check Settings → Providers → Codex → Binary path…" The log also has `ProviderDriverError … Failed to probe Codex skills`. |
| Claude provider | Detected and authenticated through the VM's CLI. Deliberately not used for turns, but used automatically for titles (see caveat). |
| Replay (dev) turns: streaming, plan, tools, approval, decline, steer, interrupt, question | Worked |
| Diff panel, file viewer, git menu, branch picker, terminal drawer (real PTY) | Worked |
| Settings, pairing-link dialog, add-environment dialog | Worked |
| Backend disconnect presentation | Worked |
| Real remote pairing from a second device | NOT observed: network access is off (loopback only) |

## Per-screenshot notes

The previous run captured 01 to 07. This run captured 08 to 45. Numbers 27 and 44 were reused or removed, so there are gaps.

- **01-first-run.png**: app splash (T3 logo) while the app loads.
- **01-after-pairing.png**: "Welcome to T3 Code, Setting up vm" onboarding.
  - The Agents list shows Claude "Ready" and Replay (dev) "Ready", plus "Add more agents" with provider icons.
  - "Import projects and their threads from your Claude Code, Codex, and Pi history", with "Review all".
  - A Start button, and a telemetry notice at the bottom.
- **02-empty-home.png**: empty home: "What should we work on? Add a project, or start without one". Buttons: "+ Add project" and "Start without a project". The sidebar says "No projects yet".
- **03-add-project-dialog.png**: add-project palette. Sources: New project, Local folder, Git URL, GitHub repository (with a "Setup Required" badge).
- **04-local-folder-picker.png**: the local folder path picker, with typed path, "Create & Add" and a Directories list.
- **05-project-added.png**: new demo-app project: "What should we build in demo-app? or start without a project".
  - Composer shows Opus 5.5 Medium and Full access.
  - The right details card shows "Initialize Git", because the folder was empty and not a repo.
- **06-home-with-project.png**: project home with the composer. Same layout as 05.
- **07-model-picker-claude.png**: model picker with the provider rail (Favorites, Codex, Claude, Replay).
  - Claude models: Opus 5.5 (selected), Sonnet 5.5, Fable 5.2, Haiku 5.5, and "Show more".
  - Right pane "Reasoning": Low / Medium (checked) / High / Extra High / Max.
  - Footer: Standard / Fast speed toggle, an "Ultracode" toggle, and a Full access permissions chip.
- **08-thread-codex-unavailable.png**: a thread whose model is Codex `gpt-6-astra`.
  - A red "Codex provider status" banner gives the binary-path error, with Refresh and dismiss buttons.
  - This is how a provider failure is presented: the composer stays enabled with the banner above it.
- **09-model-picker-replay.png**: picker on the Replay provider. It lists the six scenarios; the Effort pane says "No effort levels". For comparison:
  - Codex (unavailable) shows "No models found".
  - Claude offers effort, speed and Ultracode controls (07).
  - Replay has no effort, speed or Ultracode controls.
- **10-turn-starting-session.png**: Showcase turn, right after sending.
  - Shows "Working for 7s" and "Starting ACP Registry", which is the provider-session startup row.
  - The send button has become a red Stop button. Permission chip: "Supervised".
- **11-approval-pending-showcase.png**: during the turn, before approval.
  - Thought row, "Tasks 1/3 · Add a clamp helper" plan row, a Read tool row, streamed assistant text, and an Edit tool row (`server/src/math.ts`).
  - The approval appears inline: "Changed files · Waiting for approval · Decline · Approve · More".
  - The composer placeholder changes to "Send a message to decline and redirect the agent".
  - The sidebar thread shows an orange "Approval" badge.
- **12-approval-more-expanded.png**: the approval "More" menu: Cancel, "Always allow this session".
- **13-after-approval-streaming.png**: after Approve, while the turn finishes.
  - Shows "Tasks 3/3", "Changed 1 file, ran 1 command, and performed 1 other action", and a `vp test run` command row.
  - Final markdown streams in: "Done", a bullet list, a code block and a table.
  - The Stop button is still shown.
- **14-turn-complete.png**: after the turn.
  - Work is collapsed into "Worked for 1m 17s >" and the final answer is rendered as markdown with a table.
  - Message actions (copy, fork, edit-from-here, time) appear, and the send button is back.
- **15-steer-message-while-approval-pending.png**: a second turn is waiting for approval while the user types a new message.
  - The send button becomes a "Steer message" button (curved-arrow icon).
  - Note: the earlier composer draft had persisted and was merged into the previous message ("…pleaseRun it again please").
- **16-steered-turn-running.png**: after steering.
  - The pending turn ended ("Worked for 2.1s", "Changed 1 file") and a new turn started for the steer message ("Working for 9s", "Thinking").
  - The sidebar shows a "Working 1" section and the thread row shows "Working 9s".
- **17-run-interrupted.png**: after clicking Stop. A divider reads "Run interrupted · Stopped by user", and the completed tool summary stays visible.
- **18-inline-tool-diff.png**: the "Changed 1 file" tool row expanded inline. It shows the unified diff from the tool call (the replay's `clamp` diff) and an "Open diff" button.
- **19-command-palette.png**: Ctrl+K palette. Actions include:
  - New thread in project / in… / without project
  - Triage an issue, Find in thread, Copy thread
  - Link pull request, Restart agent session
  - Go to file, Search project contents, Add project
  - Theme and appearance, MCP ("Use T3 Code in another app"), Usage, Settings
  - Recent Threads
- **20-permission-modes-in-model-picker.png**: the permissions popover, with four modes:
  - Supervised: "Ask before commands and file changes"
  - Auto-accept edits
  - Auto: "Supported providers approve routine actions; others still ask"
  - Full access
  - The draft thread defaulted to Full access, while the `t3dev.replay` helper uses Supervised.
- **21-command-approval-pending.png**: "Write approval" scenario in demo-app.
  - A command tool row (`printf … > .codex-probe-write-action.txt`) shows "Waiting for approval · Decline · Approve · More".
  - The thread was auto-titled "Update Project README". See the credentials caveat.
- **22-command-declined.png**: after Decline, the turn ended and collapsed to "Worked for 27s". No explicit "declined" label was visible in the collapsed view.
- **23-diff-panel.png**: right panel "Diff" tab with:
  - a scope selector "Changes vs Automatic" and `+4 -0`
  - refresh, expand, unified/split, wrap, whitespace and file-tree toggles
  - one file row, `src/math.ts`
- **24-file-viewer-and-tree.png**: clicking the file opens it in a file tab (`math.ts`), with a breadcrumb, a syntax-highlighted view and a file tree with search.
- **25-diff-scope-menu.png**: diff scope menu: Changes, Uncommitted, Latest turn, Turn >, Commits >.
- **26-diff-hunks.png**: the file expanded in the Diff tab, with added lines highlighted in green and "More unchanged context may be available".
- **27-git-actions-menu.png**: the details-card git action dropdown: "Commit", "Publish repository…". There is no remote.
- **28-terminal-drawer.png**: bottom terminal drawer running a real shell in demo-app. `git status --short` shows `M src/math.ts`.
- **29-branch-picker.png**: branch picker showing `main (current)`.
- **30-question-elicitation.png**: "Question" scenario.
  - Shows "Input requested", and a question card above the composer ("Fixture: Should this fixture prefer strict schemas or UI flexibility?") with numbered options (1/2, "Recommended" tag).
  - The composer placeholder reads "Choose an option above", with Submit and Stop buttons. The sidebar badge reads "Input".
  - The permission chip is not shown while the question is pending.
- **31-question-answered.png**: after choosing option 1, which submitted immediately.
  - The answer is recorded inline as question plus answer, followed by the agent reply "plan questions fixture complete".
  - With the Question model selected, the composer showed no permissions chip.
- **32-settings-general.png**: Settings > General. It opens as a modal with a left nav:
  - Preferences: General, Appearance, Chat, Diffs & pull requests, Keybindings, Voice, SnapShots
  - Agents: Providers, Threads, Browser, Devices, Scheduled tasks
  - Code: Projects, Source control & issues, Worktrees
  - Connections: Environments, Sharing & access
  - More: Maintenance, Labs, About, Archive
  - General itself covers notifications, sidebar grouping and ordering, confirmations, language and time format.
- **33-settings-providers.png**: Providers list.
  - Codex is red: "Not found · Could not start Codex CLI".
  - Claude: v2.1.330, Authenticated. Replay (dev): v1, Available. Each has an enable toggle.
  - The Codex detail shows Binary path, CODEX_HOME, Shadow home path and Launch arguments.
  - A scope selector reads "Applying settings for All projects on vm".
- **34-settings-environments-connections.png**: Environments map: This browser → "This device" → vm (online). There is "+ Add environment" and a Map/List toggle, with legend In use / Standby / Offline / Link.
- **35-settings-sharing-access.png**: Sharing & access for vm:
  - Version 0.1.11 "Up to date"
  - Network access off: "Only this machine can connect. Restart with a non-loopback host for remote pairing."
  - Preview tunnel on
  - Permissions, and Authorized clients (1), with "Use in another app (MCP)", "Revoke others" and "Create link"
- **36-settings-devices.png**: Devices (simulators): "Use devices" and "Agents can use devices", both off, with hub and agent-device "Not installed". The Local simulators source is listed.
- **37-authorized-clients.png**: Authorized clients expanded: "Linux · Chrome — This device", "Desktop · Linux · Chrome · 127.0.0.1 · 17 scopes".
- **38-create-pairing-link.png**: "Create pairing link" dialog.
  - Optional label, and a Read only / Standard preset.
  - 17 granular scopes: view environment, operate tasks, settings, providers, maintenance, previews, diagnostics, view and use terminals, source control, read and write files, view and manage access, and relay view, manage and admin.
  - Cancel / Create link. No link was created.
- **39-access-permissions.png**: Permissions for the current connection. All 17 scopes show "Allowed".
- **40-provider-claude-detail.png**: Claude provider detail.
  - Binary path, CLAUDE_CONFIG_DIR, auto-compact threshold, idle compaction, launch args, env variables.
  - 14 models, several tagged "Fast mode"; usage providers; text generators ("No text generators yet"); advanced health-check interval.
- **41-provider-replay-detail.png**: Replay (dev) detail.
  - "No in-app sign-in advertised", ACP source "Local command", executable and argument rows, and 6 models (the scenarios).
  - It has none of Claude's compaction or fast-mode settings. This is a capability difference by provider.
- **42-add-environment.png**: "Add Environment, Pair another environment to this client", with Remote link: Host and Pairing code fields. A full pairing URL pasted there fills both fields.
- **43-server-disconnected.png**: a few seconds after the backend was killed.
  - A yellow strip above the composer: "vm is reconnecting · T3 Code on vm did not answer · Retry now".
  - Thread content stays visible. The browser console shows `ERR_CONNECTION_REFUSED`.
- **45-composer-while-disconnected.png**: while disconnected, the composer still accepts typing. The send button did not look disabled, but sending was not tried.

## NOT observed running

- A real model turn on Claude or Codex. Codex was not installed; Claude was deliberately not used for turns. Provider-specific protocol behavior and real file edits by an agent were not seen; replay tool calls do not touch disk.
- What happens when a message is sent while disconnected, and how the app recovers or reconnects after the backend comes back.
- The scenarios Plan and reads, Multi turn and Command output (beyond the showcase's `vp test run` row). Proposed-plan or plan-mode UI was not opened.
- Actual remote pairing from another device, the T3 Connect relay, tunnels, and SSH or Tailscale environments.
- Commit, push and PR flows; worktree creation; project scripts.
- Mobile and desktop (Electron) clients.
- Dark theme.
- Provider install or sign-in flows ("Add more agents", "Add provider").
