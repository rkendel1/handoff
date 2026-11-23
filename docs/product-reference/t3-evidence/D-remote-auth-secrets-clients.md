# D. T3 Code: remote environments, auth and scoped access, reconnect, secrets, clients

Read-only audit of `/home/user/rkendel1/t3code` at commit `fab237d6`. T3 is a product and interaction **reference**:
nothing here should be ported. In T3 the execution environment (the `t3` server on the user's machine) **owns product
state**: threads, sessions, pairing grants and secrets all live in that server's SQLite and secrets directory, and
every client is a view onto it. In Handoff the system of record is the FeltKit app, and EVE runners are untrusted,
replaceable executors. Read every "lesson" below with that inversion in mind.

Conventions:
- **Fact:** a statement backed by `path:line` (T3 paths are relative to the T3 repo root, Handoff paths to
  `/home/user/handoff`).
- **Judgment:** marked _J:_, my interpretation or recommendation.
- Fields per capability: Problem · Action → transition (server) · Visible (client) · Durable/transient · On connection
  failure · Safe retry · Authority · T3-local-model specifics · Handoff today · Where it belongs.

---

## 1. Pairing a new client to an environment (one-time pairing links/codes)

- **Problem.** Get a phone, browser or another desktop authorized to a server without typing a password, and without
  a long-lived secret in a URL.
- **Action → transition.**
  - `t3 pair` / Settings → Sharing & access → "create link" calls `EnvironmentAuth.createPairingLink`
    (`apps/server/src/auth/EnvironmentAuth.ts:1203-1213`), refused when managed policy forbids remote clients
    (`:1206-1211`).
  - `PairingGrantStore.issueOneTimeToken` writes a `pairing_links` row with scopes, subject, label, optional
    proof-key thumbprint, `expiresAt` (`apps/server/src/auth/PairingGrantStore.ts:458-531`). Default TTL is 5 minutes
    (`:326`); the code is drawn by rejection sampling from `PAIRING_CODE_ALPHABET` (`:361-383`).
  - Redeeming: `consume` is a single conditional `UPDATE` that checks expiry, proof key, and scopes **in the same
    statement so a rejected request cannot spend the link** (`:646-660`). On failure it re-reads to return a precise
    reason: unknown / revoked (`UnavailableBootstrapCredentialError`) / expired / proof-key mismatch / scope not granted
    / approval pending (`:675-719`). Typed codes are normalized (`XXXX-XXXX-XXXX`, case-insensitive) (`:637-642`).
  - Exchange produces a session (`exchangeBootstrapCredentialForAccessToken`, `EnvironmentAuth.ts:1107-1167`).
- **Visible.**
  - Pairing links list with an expiry countdown and Revoke button
    (`apps/web/src/components/settings/AuthorizedClientsSettings.tsx:165, 262-294, 401-404`).
  - Link creation/removal is pushed live over an access stream (`pairingLinkUpserted` / `pairingLinkRemoved`,
    `PairingGrantStore.ts:392-402`; schema `packages/contracts/src/auth.ts:420-448`).
  - Docs: QR code or pasted URL; links created in Settings can only be copied while that page stays open
    (`docs/user/remote-access.md:115-133`).
  - Hosted web pairing puts the secret in the URL **fragment**, never in query/search, and strips it from history
    (`docs/internals/05_remote.md` "Hosted web is a client"; test `apps/web/src/hostedPairing.test.ts:25-41`;
    startup URL uses `url.hash`, `EnvironmentAuth.ts:1493-1503`).
- **Durable vs transient.** Pairing link rows are durable (SQLite) but short-lived. The raw credential is returned
  **only in the creation response**; listings carry metadata only (`docs/internals/04_environment-auth.md`
  "No recoverable secrets in read models"; `AuthPairingLink` has no credential field, `contracts/src/auth.ts:375-385`).
  Fact worth noting: the pairing credential column is stored and matched in plaintext
  (`apps/server/src/persistence/AuthPairingLinks.ts:242, 369`), mitigated by the 5-minute TTL.
- **On connection failure.** Unconsumed link simply expires. Consumption is atomic, so a dropped response after a
  successful redeem leaves the link spent; the client must pair again with a new link.
- **Safe retry.** Retrying a *rejected* redeem is safe (link not spent). Retrying a *successful* redeem is not
  (single use).
- **Authority.** Creating a link requires `access:write` **and** every scope being delegated (narrowing only;
  `04_environment-auth.md` "Narrowing only").
- **T3-local specifics.** The server that runs the agents mints its own credentials; there is no central identity.
- **Handoff today.** No pairing. Runners get `HANDOFF_TOKEN` (the shared `runner-pool` session) from the operator via
  env (`runner/src/runner.mjs:26`); production sessions are `feltkit session create --type service`
  (`docs/IMPLEMENTATION-REPORT.md:187-188`).
- **Belongs.** Credential minting / one-time enrollment codes: **FeltKit platform** (sessions/API keys). A
  "register a runner" UX that shows a one-time code and its expiry: **Handoff** UI on top of FeltKit.
  _J:_ The two transferable ideas are (a) single-use, short-TTL enrollment code that is exchanged for a durable
  credential, and (b) "check every precondition inside the consuming write so a refused attempt does not burn it".

## 2. Scoped sessions and per-call authorization

- **Problem.** Give a phone read/approve access without giving it a shell; keep old clients working when scopes split.
- **Transition / enforcement.**
  - Scope vocabulary: 18 literals (`packages/contracts/src/auth.ts:40-70`); default "standard" grant includes
    management scopes because `terminal:operate` already implies OS-user execution (`auth.ts:155-178`; rationale in
    `04_environment-auth.md` "Why the default grant includes management scopes").
  - Exchange intersects requested scopes with the grant and fails if empty (`EnvironmentAuth.ts:1124-1131`).
  - **Every RPC statically declares a required scope**; an undeclared method throws (`RpcAuthorization.ts:44-260`).
    Some RPCs compute scopes from payload (settings patch, secret references, provider sign-out prompt,
    `RpcAuthorization.ts:268-353`). Enforcement middleware `RpcAuthorization.ts:356-367`.
  - Denials return both legacy `requiredScope` and exact `requiredPermission` (`contracts/src/auth.ts:113-122`).
- **Visible.** Client-side `sessionGrantsScope` hides/greys affordances (`contracts/src/auth.ts:131-146`).
- **Durable.** Scopes are stored on the session row; servers never expand stored grants when scopes split
  (`04_environment-auth.md` "Backward-compatible scope evolution").
- **Failure / retry.** A scope denial is a `blocked: permission` outcome, not retried
  (`packages/client-runtime/src/connection/model.ts:73-79`).
- **Authority.** The session's own scopes; device metadata/labels have no authorization role.
- **Handoff today.** FeltKit roles + per-function `access` permission; runner functions take a `claim` and are refused
  for stale claims (`feltkit/runner.ts:121-135`). Role `runner` can call `github.observe/verify` by design rule only
  (`IMPLEMENTATION-REPORT.md:170-172`).
- **Belongs.** **FeltKit** (roles/permissions, no internal-only functions is a FeltKit gap, report item 3).
  _J:_ Adopt the discipline, not the mechanism: a test asserting that every `runner.*` function declares a narrow
  permission and none is reachable by the runner role unintentionally is cheap and mirrors T3's "undeclared method
  throws".

## 3. Seeing who is connected: client sessions list with live presence

- **Problem.** "Which devices can reach my machine, and which are online now?"
- **Transition.**
  - WebSocket upgrade wraps the RPC server in `acquireUseRelease(markConnected, …, markDisconnected)`
    (`apps/server/src/ws.ts:3882-3896`).
  - `markConnected` increments an **in-memory** ref-count per session; on 0→1 it persists `lastConnectedAt` and
    publishes `clientUpserted` (`apps/server/src/auth/SessionStore.ts:649-681`). `markDisconnected` decrements and
    republishes (`:683-707`).
  - Listing marks `connected` from the in-memory map (`SessionStore.ts:1161-1177`); a connected session whose
    credential expired is still listed so it stays manageable (`:631-633`; `09_connection-runtime.md`).
- **Visible.** Green pinging dot when `current || connected`, tooltip "Connected for {duration}", else "Last connected
  at {time}" or "Not connected yet."; device type/OS/browser/IP; "This device" badge
  (`apps/web/src/components/settings/AuthorizedClientsSettings.tsx:521-560`). Connected rows sort first
  (`ConnectionsSettings.logic.ts:352-353`). Live via `subscribeAuthAccess` (requires `access:read`,
  `RpcAuthorization.ts:248`).
- **Durable vs transient.** `connected` is **transient** (process memory; resets on server restart);
  `lastConnectedAt` is **durable**. The two are deliberately kept separate.
- **On failure.** Socket close → `markDisconnected` in the release step, so presence is derived from the transport,
  not self-report. Server heartbeat frame every 20 s keeps proxies from idling the socket
  (`apps/server/src/socketHeartbeat.ts:5-11`).
- **Authority.** `access:read` to view.
- **T3-local specifics.** Presence is *observed by the server* on an authenticated socket it holds open.
- **Handoff today.** `workers` collection with `firstSeenAt`/`lastSeenAt`, self-reported state, capabilities,
  `lastError` (`feltkit/app.ts:115-131`), upserted by `runner.heartbeat` (`feltkit/runner.ts:251-269`) every 10 s
  (`runner/src/runner.mjs:67-68`). `admin.listWorkers` returns `ageMs` (`feltkit/admin.ts:104-109`) but **no UI renders
  it**: the Agents page "Runners" section is static text (`src/App.tsx:217-219`; `grep listWorkers src/` is empty).
  Per-attempt runner labels are shown as "asserted" (`src/WorkDetail.tsx:74, 93, 138`).
- **Belongs.** Display: **Handoff**. Authenticated per-connection presence: **FeltKit** (session-level) gap.
  _J:_ Highest-value, lowest-cost lesson. Render the workers registry with T3's vocabulary: a status dot derived from
  `ageMs` vs a threshold tied to the heartbeat interval (e.g. live if `< 3×interval`, stale otherwise), "Last heard
  {time}", "Not heard from yet", and the current attempt link. Label it *self-reported* (Handoff's `Trust` component
  already exists). Keep "liveness" (transient, derived) separate from "registered/first seen" (durable). Do **not**
  imply authentication T3 has and Handoff lacks.

## 4. Revocation: one client, all others, one device key; live cut-off

- **Problem.** Lost phone; stale browser; compromised device.
- **Transition.**
  - `revoke(sessionId)` sets `revokedAt`, drops it from the connected map, publishes `clientRemoved`
    (`SessionStore.ts:1184-1203`).
  - `revokeClient` revokes the **device key** (all its sessions + pending credentials) when the session is DPoP-bound,
    because "a T3 Connect device would otherwise mint itself a new session right away" (`EnvironmentAuth.ts:1452-1460`).
  - Cannot revoke your own current session from the list; revoking a sibling session on your own device revokes only
    that session (`EnvironmentAuth.ts:1462-1476`). "Revoke others" keeps the caller (`:1479-1490`).
  - **Live sockets die on revocation**: the socket races the RPC server against `awaitInvalidation`, which subscribes
    *before* reading to close the race with upgrade (`ws.ts:3884-3893`; `SessionStore.ts:1260-1290`).
  - Pairing-link revoke: `PairingGrantStore.revoke` (`PairingGrantStore.ts:442-456`).
  - CLI parity for headless hosts: `t3 auth session list|revoke`, `t3 auth pairing list|revoke`,
    `t3 auth connect-device list|revoke` (`apps/server/src/cli/auth.ts:136-378`).
- **Visible.** "Revoking…" in-flight label, then the row disappears via the access stream
  (`AuthorizedClientsSettings.tsx:577-580`). The revoked client's connection goes to `blocked: authentication`.
- **Durable.** Revocation is durable; there is no un-revoke.
- **Retry.** Idempotent (returns `false` if already revoked).
- **Authority.** `access:write`.
- **Handoff today.** Revoking the shared `runner-pool` session stops **all** runners; individual revocation is
  impossible (`IMPLEMENTATION-REPORT.md:168-169`; `src/App.tsx:218`). Handoff can suspend an *agent definition*
  (`src/App.tsx:209`) but not a runner process. FeltKit already provides: session list/revoke
  (`node_modules/@feltdb/feltkit/docs/AUTH.md:117-118`), stream re-check every 15 s so open streams close on
  revocation (`AUTH.md:119`), and an `auth.onSessionEnd` hook with `{session, reason}` run at least once
  (`AUTH.md:126-153`). Handoff does not use `onSessionEnd` or `ctx.auth.session` (`grep` in `feltkit/` is empty).
- **Belongs.** Revocation mechanics: **FeltKit**. Per-runner identity: **FeltKit E-1**.
  _J (to verify against FeltKit):_ `feltkit session create --id <id> --type service --label <text>` accepts a label
  (`node_modules/@feltdb/feltkit/dist/cli/main.js:323`) and `ctx.auth.session` exposes a per-session **ref**
  (`dist/runtime/runtime.d.ts:92`). If FeltKit allows several labeled sessions for the *same* `runner-pool` principal,
  Handoff could issue one session per runner host, record `ctx.auth.session.ref` (server-observed, not asserted) on
  `workers` and attempts, show "revoke this runner" (revoke that ref), and use `onSessionEnd` to mark the worker
  revoked and let leases lapse. Invocation visibility (E-1) is unchanged because the principal is the same. This
  narrows the gap without adopting T3's model. Not verified: whether multiple concurrent sessions per principal id are
  permitted and whether `ctx.auth.session` is populated for bearer service calls on `/api/*`.

## 5. Credential lifetime, renewal, and binding (DPoP, WebSocket tickets)

- **Facts.**
  - Default session TTL 30 days, WS ticket TTL 5 min (`SessionStore.ts:492-493`).
  - Plain pairing-link DPoP sessions get a 1 h access token inside a 30 d sliding renewal window
    (`EnvironmentAuth.ts:94-96, 1133-1149`); renewal is in place on the same session id so live sockets and access
    rows stay stable (`SessionStore.ts:968-1040`). T3 Connect/CLI/desktop/peer sessions **never self-renew**, so
    unlinking or rotating cuts them off (`EnvironmentAuth.ts:1132-1137`).
  - Long-lived tokens never appear in socket URLs: clients mint a short-lived WS ticket over authenticated HTTP
    (`EnvironmentAuth.ts:1505-1530`).
  - DPoP: an invalid proof fails rather than falling back to bearer (`04_environment-auth.md`).
  - Client: renewal failure belongs to the HTTP call; never tear down a healthy socket because refresh failed
    (`docs/internals/09_connection-runtime.md` "HTTP authorization vs. socket lifetime").
- **Handoff today.** Runner uses one static bearer token (`runner/src/runner.mjs:26`); FeltKit default lifetime 7 days
  (`AUTH.md:115`). Runner loop logs `heartbeat refused` and continues (`runner.mjs:49`).
- **Belongs.** **FeltKit** (token types, renewal). _J:_ For Handoff runners, the actionable lesson is error
  classification: an `UNAUTHORIZED` with `hint: "SESSION"` (`AUTH.md:119`) must stop the claim loop and show a
  "credential revoked/expired" state, not be logged and retried forever like a transient error (see §8).

## 6. Device approval with a verification code (T3 Connect)

- **Problem.** A cloud relay can mint credentials; a compromised relay should not grant access silently.
- **Transition.** With `requireConnectDeviceApproval`, a new DPoP key's credential is minted but unspendable
  (`BootstrapCredentialConnectApprovalPendingError`, `PairingGrantStore.ts:91-101, 713-717`) until someone with
  `access:write` approves; approval trusts the key thumbprint durably; revoking the key revokes its sessions and
  pending links (`PairingGrantStore.ts:760-860`; `06_t3-connect.md` "Explicit trust assumption & device approval").
  Already-used keys are remembered so enabling approval later does not lock them out (`EnvironmentAuth.ts:1114-1121`).
- **Visible.**
  - Both sides show the same short code derived from the key thumbprint (`contracts/src/auth.ts:340-350`).
  - Waiting client: banner "{environment} is waiting to approve this device" with the code, phase stays
    "reconnecting", not "error" (`client-runtime/src/connection/presentation.ts:57-68`;
    `apps/web/src/components/chat/useSystemComposerBanners.tsx:189-219`). Approval waits poll every 4 s and do not
    count toward backoff (`client-runtime/src/connection/supervisor.ts:50, 1176-1177, 1296`).
  - Approver (mobile): one prompt at a time, "Approve it only if that code matches", oldest first; "later"/"retry"
    re-queue (`apps/mobile/src/features/connection/connectDeviceApproval.ts:19-104`). Request expires after 10 min
    (`docs/user/remote-access.md:50-56`). CLI: `t3 auth connect-device approve <code>`.
- **Handoff today.** Not applicable (no device enrollment). FeltKit invocation approval is person-only and
  digest-bound for "open PR" (`IMPLEMENTATION-REPORT.md:16`), which is a different concept (approving an *action*).
- **Belongs.** **FeltKit / AuthBoundry** if runner enrollment ever needs human approval.
  _J:_ Interaction lesson for runner registration: a new runner can show "waiting for approval, code ABCD-1234" in
  its log while the admin sees a pending row with the same code; the pending state is distinct from failure and does
  not consume retry budget.

## 7. Headless / agent principals: CLI tokens, peer links, MCP clients, guest links

- **Facts.**
  - `t3 auth session issue --scopes … --ttl … --label …` mints a scoped bearer for headless clients
    (`apps/server/src/cli/auth.ts:293-326`).
  - Peer links: one environment's agents sign in to another's `/mcp` as an OAuth client; the receiver lists/revokes it
    like any session; forwarded calls carry the agent's mode ceiling which can only narrow; **idempotency keys are
    hashed with the caller's namespace because all callers on the linking side share one session**
    (`docs/internals/05_remote.md` "Peer links"; `apps/server/src/peer/PeerLinks.ts`).
  - Non-full-access linked work is fenced by an immutable `linkOrigin` stamp (`05_remote.md`; `mcp/linkOrigin.ts`).
  - MCP clients are a separate audience rejected on every non-`/mcp` route (`04_environment-auth.md`).
  - Guest links are HMAC tokens bound to one share, never session rows; closing the share revokes all
    (`04_environment-auth.md` "Guest links are not sessions").
- **Handoff today.** Exactly the shared-session situation T3 handles for peer links: one `runner-pool` session for
  many processes. Handoff already scopes writes by `claim` and lease fencing (`feltkit/runner.ts:121-135`) and
  de-duplicates runner events by `seq` (`runner.ts:142`).
- **Belongs.** **Handoff** (namespacing), **FeltKit** (principal types).
  _J:_ Direct lesson: any idempotency key a runner sends under the shared session must be namespaced by
  instance+attempt (or by the server-observed session ref from §4), otherwise two runners can collide. Check
  `runner.openPullRequest`'s idempotency key derivation with this in mind.

## 8. Reconnect: one retry owner, transient vs blocked, probe on wake

- **Facts.**
  - The supervisor is the **sole** owner of transport retries; endpoint resolution and RPC open are single attempts
    (`09_connection-runtime.md`; `client-runtime/src/connection/supervisor.ts`).
  - Backoff: 1 s base, 5 min cap, jittered; resets only after 30 s connected; 250 ms after a session loss
    (`supervisor.ts:46-50, 73, 1117-1126, 1296-1317`).
  - Failure taxonomy: transient (`network, timeout, transport, endpoint-unavailable, relay-unavailable,
    remote-unavailable, session-pending, approval-pending`) vs blocked (`authentication, configuration, permission,
    unsupported`); blocked waits for an explicit wakeup (`model.ts:61-79`). Failures carry the hop (`device, relay,
    tunnel, server`) and a cause (`clock_skew`, `not_linked`, …) for diagnosis (`model.ts:82-95`).
  - Phases: `available, offline, connecting, backoff, connected, blocked` (`model.ts:177-183`), presented as
    connecting/reconnecting/connected/error/unsupported with `retryAt` and a trace id (`presentation.ts:11-80`).
  - Foreground/network-change/explicit retry **probe** the existing session; only a failed probe replaces the socket
    (`09_connection-runtime.md`).
  - Web suppresses the "reconnecting" banner for a 2 s grace (`apps/web/src/components/ChatView.logic.ts:116`;
    `useSystemComposerBanners.tsx:186-197`).
- **Handoff today.** Runner polls with back-off up to 15 min (`IMPLEMENTATION-REPORT.md:209`); heartbeat errors are
  logged and ignored (`runner/src/runner.mjs:47-50`); runner declares `reconnect: "none"` (cannot reattach an EVE
  session after process death; recovery is a new attempt) (`runner.mjs:38-43`). Note: `HEARTBEAT_MS` is computed as
  `LEASE_MS/4` (`runner.mjs:29`) but the registry heartbeat uses a hard-coded 10 000 ms (`runner.mjs:68`).
- **Belongs.** Runner loop: **Handoff** (`runner/`), or **EVE** if a runner harness moves into the platform.
  _J:_ Adopt the taxonomy: the runner should distinguish *transient* (network, 5xx → backoff, keep heartbeat
  `lastError`) from *blocked* (`UNAUTHORIZED hint SESSION`, permission → stop claiming, report `state: "blocked"` if
  it still can, exit non-zero). Surface `lastError` and a computed "retrying"/"blocked" on the workers UI. The
  hard-coded 10 s heartbeat vs `LEASE_MS/4` is a small consistency fix.

## 9. Session continuity: transport health vs data freshness; replay cursors; no auto-replayed mutations

- **Facts.**
  - An open socket ≠ usable; subscriptions keep their own sync state; never label a failed subscription
    "reconnecting" when the transport is healthy (`09_connection-runtime.md` "Transport health and data freshness").
  - Thread subscriptions resume from a cached `sequence` via `afterSequence`; cache and cursor commit together only
    after an update applies; cancelled scopes must not advance the cursor (`client-runtime/src/state/threads.ts:288-345,
    471-492, 553-572`).
  - Server stream = replay stored events up to the high-water mark, then live events above it, no gap/no duplicate
    (`apps/server/src/orchestration-v2/EventSink.ts:1020-1062`).
  - **Reconnection never auto-replays mutations**; retry and idempotency belong to each operation
    (`09_connection-runtime.md`). Commands carry `commandId` with durable receipts
    (`orchestration-v2/ThreadMessageIntake.ts:110`; `CommandReceiptStore.ts:40`).
  - An involuntary disconnect keeps registration and cached projections; explicit removal clears credentials, caches,
    drafts (`09_connection-runtime.md` "registry").
  - Cached projections stay readable offline but must never imply a live connection (`09_connection-runtime.md`).
- **Server disconnect mid-turn.** Agent runs live in the server process, so a *client* disconnect does not affect the
  turn. On a *server/provider* restart, tool calls the dead process started are written `interrupted` with
  `completedAt` (`orchestration-v2/ProviderSessionManager.ts:1095-1150`), and background work gets a note telling the
  agent "the T3 server restarted … resume or restart what you still need" (`RestartBackgroundNote.ts:138-148`).
- **Handoff today.** Runner events are sequenced and duplicate `seq` ignored (`feltkit/runner.ts:121-145`); lease expiry
  → attempt n+1 with `previous` (`IMPLEMENTATION-REPORT.md:19`); FeltKit live queries handle client freshness; the
  steering SSE re-reads every second (`IMPLEMENTATION-REPORT.md` platform item 5). FeltKit's event stream ends every
  ~60 s (lease) (`IMPLEMENTATION-REPORT.md:297`).
- **Belongs.** **Handoff** already has the right shape (FeltKit owns state; runner is an executor).
  _J:_ Lessons: (1) in the UI, separate "runner connected" (heartbeat age) from "run data fresh" (last event
  `receivedAt`) and never show one as the other; (2) after lease-expiry recovery, mark the previous attempt's open
  items as *interrupted by runner loss* explicitly (T3 writes `interrupted`, it does not leave them "running"), and
  give the next attempt's agent a short note analogous to `RestartBackgroundNote`; (3) never let the runner
  auto-resend a consequential write after reconnect without its idempotency key.

## 10. Remote routes: direct/LAN, Tailscale, SSH, T3 Connect relay

- **Facts.**
  - Routes only change reachability, not the execution model; environment identity is stable across routes and
    restarts; routes are untrusted hints, verified before sending credentials; never downgrade HTTPS→HTTP; never fall
    back to loopback (`docs/internals/05_remote.md` "Identity is independent of the route").
  - Tailscale supplies an endpoint only; auth stays with the environment (`05_remote.md`; `packages/tailscale/src/tailscale.ts`).
  - SSH cleanup stops a remote server only if the launcher started it (`05_remote.md`; `packages/ssh/src/tunnel.ts:1022,
    1093`; user doc `remote-access.md:274-283`).
  - T3 Connect relay is a trusted broker that mints DPoP-bound bootstrap credentials; data flows directly to the
    environment's tunnel, the relay is not in the data path (`06_t3-connect.md`).
  - Managed policy can forbid remote clients (`EnvironmentAuth.ts:1206-1211`).
- **Handoff.** **Not applicable** as product features: Handoff is a hosted FeltKit app; runners dial out to it.
  _J:_ The only transferable rule is "verify the endpoint is the expected deployment before sending the runner
  credential, and never send it over plain HTTP outside localhost" (`runner.mjs:25` defaults to
  `http://localhost:3000`). Belongs in **Handoff runner** (a startup check) or **AppPort/FeltKit client**.

## 11. Secrets and credentials

### 11a. Settings secrets kept out of clients and logs
- Inline secret fields in settings are moved to the secret store on save and replaced by `{value:"", redacted:true}`
  (`apps/server/src/serverSettings.ts:801-829`).
- Clients get redacted settings; older clients see `••••••` for references (`serverSettings.ts:144-159`;
  `settingsSecrets.ts:30`).
- Secret store: one file per secret in a `0700` directory, files `0600`, atomic write via temp + rename
  (`apps/server/src/auth/ServerSecretStore.ts:173-188, 232-234, 272-277`).
- Logger redacts credentials from causes (`apps/server/src/serverLogger.ts:16-23`;
  `packages/shared/src/observability.ts:567`).
- Supplying a secret reference to an RPC that sends it to a caller-named URL requires `settings:write` +
  `providers:manage` (`RpcAuthorization.ts:331-338`).

### 11b. Secret providers (1Password)
- Provider interface: `read(config, references) → (string|undefined)[]`, never fails; undefined = unreadable
  (`packages/secret-provider-core/src/server/driver.ts:16-26`). Definitions carry reference syntax/placeholder
  (`secret-provider-core/src/shared/definition.ts:4-13`).
- 1Password driver runs `op --cache=false`, batches via `op inject` with a random separator, one deadline for batch +
  fallback, logs only counts/stage/exit code, never values (`packages/secret-provider-onepassword/src/server/driver.ts:21,
  46-120`).
- Resolver caches per (provider, reference, config); `fresh` re-reads but an unreadable answer never replaces a held
  value (`secret-provider-core/src/server/SecretResolver.ts:14-48`).
- UX: per-field source picker Value vs provider reference; "check" reads now; locked 1Password names the provider and
  never falls back to another login; removing a provider lists dependent fields (`docs/user/secrets.md`).

### 11c. Agent-requested secrets
- Agent shows a secret request card instead of asking in chat; user answers from web/desktop/mobile; value stored
  behind a one-use HMAC ref with 24 h TTL; orchestration records only status (`saved`/`declined`)
  (`apps/server/src/secrets/SecretRequests.ts:1-4, 36, 157-217`). Refuses if already answered or the run is terminal
  (`:174-180`). Writes storage before recording so racing answers cannot show "saved" before storage, and cleans up on
  failure (`:181-212`). `file` mode writes owner-only files the agent's shell can read (`:4, 88-99`).

### 11d. Client-side credential storage
- Desktop: connection catalog encrypted with Electron `safeStorage`; if encryption is unavailable it **refuses to
  persist** rather than writing plaintext; an unreadable catalog is copied aside, not destroyed
  (`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:388-410, 418-430, 526-538`).
- Mobile: `expo-secure-store` (`apps/mobile/src/persistence/mobile-secure-storage.ts:1-50`).
- Web: IndexedDB; DPoP private key is a non-extractable WebCrypto key; mobile uses native P-256
  (`packages/client-runtime/src/relay/dpopProof.ts:2`; `apps/web/src/cloud/dpop.ts:13-59`).

- **Handoff today.** GitHub credential is a FeltKit custody reference; model key and git credentials live only in the
  runner's env; sandbox has no network/credentials; evidence scanned for secrets (`IMPLEMENTATION-REPORT.md:178-182`).
  Runner heartbeat `lastError` is truncated to 500 chars (`runner.mjs:48`) and run event text to 4000
  (`feltkit/runner.ts:142`) without redaction.
- **Belongs.** Custody/vault: **FeltKit / AppPort Services**. Redaction of runner-reported text: **Handoff** (at the
  `runner.report`/`runner.heartbeat` boundary) and the **runner**.
  _J:_ Lessons: (1) apply a credential-pattern redactor to `lastError` and event `text` before storing (T3 redacts at
  the logger and keeps values out of projections entirely); (2) agent-requested secrets as a first-class turn item
  with status-only history is the right shape if Handoff ever lets an agent ask the delegator for a credential mid-run
  (belongs in Handoff + FeltKit custody, value never in `runEvents`); (3) a provider-reference model ("op://…" or a
  FeltKit custody ref) shown with a "check now" action is a good admin UX for the GitHub credential.

## 12. Web vs desktop vs mobile behavior

- **Shared runtime.** One connection owner per environment in `packages/client-runtime`; platform code supplies
  storage, credentials, network signals and lifecycle (`09_connection-runtime.md`). Platform capabilities are injected
  services (`CloudSession`, `RelayDeviceIdentity`, `ClientPresentation`;
  `packages/client-runtime/src/platform/capabilities.ts:23-58`). Older servers are handled by advertised capabilities,
  not version parity (`05_remote.md` "Access and process ownership").
- **Desktop-only.** SSH launch/tunnel, loopback preview tunneling via fixed SOCKS5 (never falls back to the reviewer's
  own localhost), `t3code://pair` deep link with address confirmation (`05_remote.md`; `remote-access.md:118-120`).
- **Mobile.**
  - Push requires T3 Connect; direct/Tailscale alone gives no push (`docs/user/mobile-notifications.md`).
  - Activity phases published: `starting, running, waiting_for_approval, waiting_for_input, completed, failed, stale`
    (`packages/contracts/src/relay.ts:22-30`); payload has project/thread titles, headline, model, deep link
    (`relay.ts:119-130`).
  - Notification tap deep-links to the thread, de-duplicated by response id
    (`apps/mobile/src/features/agent-awareness/notificationPayload.ts:37-118`). **No inline notification actions**: no
    `setNotificationCategoryAsync`/`actionIdentifier` in `apps/mobile/src` (grep empty). Approvals are answered
    in-app over the live connection.
  - Live Activity cards set an APNs `stale-date`; "Without final content, the card freezes at stale state; dismiss it
    promptly" (`infra/relay/src/agentActivity/ApnsClient.ts:24, 201`); widget marks unfinished work out of date after
    10 min (`mobile-notifications.md`).
  - Foreground suppresses ordinary alerts; viewing on another device does not silence the phone
    (`mobile-notifications.md`).
- **Handoff today.** Web only. Approval request sends a FeltKit notification to the delegator
  (`feltkit/runner.ts:183`); approval via FeltKit invocation routes (`IMPLEMENTATION-REPORT.md:85`). Mobile deferred
  (`IMPLEMENTATION-REPORT.md:29`).
- **Belongs.** Push/mobile delivery: **AppPort Services** (notifications). Mobile client: **Handoff** later.
  _J:_ Lessons: (1) approval notifications should deep-link to the exact approval and the approval screen must
  re-read the digest/head live, not trust the notification body (T3 deliberately avoids approve-from-notification);
  (2) include a `stale` phase: a delegation whose runner has stopped heartbeating should *read* stale everywhere
  (list, detail, notification), not keep saying "running".

---

## Summary matrix

| # | Capability | Handoff today | Belongs |
|---|---|---|---|
| 1 | One-time pairing code → durable credential | Operator-issued shared token | FeltKit (mint) + Handoff (UX) |
| 2 | Scoped sessions, per-call declared scope | FeltKit roles + claim fencing | FeltKit; Handoff test discipline |
| 3 | Live connected / last-connected list | `workers` + `listWorkers`, **not rendered** | Handoff (display); FeltKit (authenticated presence) |
| 4 | Per-client revocation, live cut-off | Pool-wide only | FeltKit E-1; possible Handoff use of `ctx.auth.session`/`onSessionEnd` (verify) |
| 5 | Renewal, DPoP, WS tickets | Static bearer | FeltKit |
| 6 | Device approval with matching code | N/A | FeltKit/AuthBoundry if ever needed |
| 7 | Headless tokens, peer links, namespaced idempotency | Shared session; claim + seq dedupe | Handoff (namespacing) |
| 8 | Single retry owner, transient vs blocked | Logs and retries | Handoff runner / EVE |
| 9 | Replay cursor, no auto-replayed mutations, interrupted marking | seq dedupe, lease recovery | Handoff (already right shape) |
| 10 | Tailscale/SSH/relay routes | N/A | Not applicable |
| 11 | Secret store, redaction, provider refs, secret requests | Custody ref; runner env | FeltKit/AppPort Services; Handoff redaction |
| 12 | Web/desktop/mobile split, push phases incl. `stale` | Web + FeltKit notification | AppPort Services; Handoff |

## What not to adopt

- T3's environment mints its own credentials and stores sessions, grants and secrets locally because the execution
  environment *is* the product. Handoff runners must not hold product state, mint credentials, or be the authority on
  their own identity; the workers registry stays self-reported evidence until FeltKit provides per-runner identity.
- T3's default grant is broad because a full client can already run shell commands. Handoff's runner role should stay
  narrow; T3's rationale does not transfer.
- Approve-from-anywhere device approval is about trusting *clients*; Handoff's approvals are about *actions*
  (digest-bound invocation approval), which is the stronger model and should stay.
