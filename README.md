# Handoff

A system of record for delegated software work, built on FeltKit 0.3.37.

A person delegates repository work to an agent. A runner from a trusted pool claims it under a FeltKit lease and runs a real
[EVE](https://github.com/rkendel1/eve2) agent in a Docker sandbox. The person watches and steers it ("update coming", pause,
interrupt, stop) and approves the pull request.

Handoff reconciles what GitHub actually shows, so these stay separate records:
- **reported**: the agent's claim;
- **verified**: the commit observed on GitHub;
- **accepted**: a person's decision.

A runner that crashes, even right after creating a PR, is recovered by another runner without duplicate effects.

- **Report:** [docs/IMPLEMENTATION-REPORT.md](docs/IMPLEMENTATION-REPORT.md). What is implemented and verified, the
  evidence, and the platform gaps.
- **Plan and design decisions:** [docs/PLAN.md](docs/PLAN.md).
- **Product discovery:** `rkendel1/felt-ops` `docs/product-discovery/`.

## Run

The app needs Node 22.

```bash
npm install
```

```bash
GITHUB_API_URL=https://api.github.com FELTKIT_CREDENTIAL_GITHUB=<token> npx feltkit dev
```

The runner needs Node 24 or later, Docker and a model key. It is a separate process with the pool's shared session.

```bash
cd runner && npm run setup
```

```bash
npx feltkit session create --id runner-pool --type service --role runner
```

```bash
HANDOFF_URL=http://localhost:3000 HANDOFF_TOKEN=<session> ANTHROPIC_API_KEY=<key> node runner/src/runner.mjs
```

## Verify

| Command | Proves |
|---|---|
| `npm test` | 13 lifecycle, authority and failure-path tests, including the crash-after-PR recovery scenario |
| `node scripts/ui-check.mjs` | the steering controls against a real server, in a browser |
| `RUNNER_NODE=<node24> ANTHROPIC_API_KEY=<key> node scripts/live-recovery.mjs` | two real runner processes, real EVE: crash after PR, takeover, no duplicate, verified, accepted |

## Constraints

- **One trusted runner pool per deployment, sharing one identity.** Runners can't be attributed or revoked individually.
- **GitHub is polled.** GitHub-native webhooks are not accepted by the platform.
- **EVE's coding quality on realistic work is unproven.** Phase 0 S1 passed only on easy tasks; S1b is pending.
