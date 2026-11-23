/**
 * Settings: the workspace's connections, execution policy, approval rules, credential references
 * and declared runtime capabilities. Values are records Handoff owns; secrets never appear here.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Section, ago } from "./ui";

export function Settings({ report }: { report: (e: unknown) => void }) {
  const repos = useQuery(api.admin.listRepositories);
  const settings = useQuery(api.admin.settings);
  const add = useMutation(api.admin.addRepository);
  const check = useMutation(api.admin.checkConnection);
  const setPolicy = useMutation(api.admin.setPolicy);
  const syncNow = useMutation(api.github.syncNow);
  const [checked, setChecked] = useState<Record<string, string>>({});
  if (!settings) return <p className="muted">Loading…</p>;
  const p = settings.policy;
  return (
    <div className="stack">
      <h2>Settings</h2>
      <Section title="Repositories">
        <table><thead><tr><th>Repository</th><th>Default branch</th><th>Connection</th><th /></tr></thead>
          <tbody>{repos?.map((r) => {
            const c = settings.connections.find((x) => x.repositoryId === r.id);
            const ok = c?.lastOkAt && (!c.lastErrorAt || c.lastOkAt > c.lastErrorAt);
            return (
              <tr key={r.id} data-repo={`${r.owner}/${r.name}`}>
                <td>{r.owner}/{r.name}</td><td>{r.defaultBranch}</td>
                <td>{!c ? <span className="muted">not checked</span> : ok ? <span>✓ read {ago(c.lastOkAt)}</span> : <span className="danger-text">✗ {c.lastError}</span>}{checked[r.id] && <div className="small muted">{checked[r.id]}</div>}</td>
                <td><button className="secondary" onClick={() => void check({ repositoryId: r.id }).then((x: any) => setChecked((m) => ({ ...m, [r.id]: x.ok ? `GitHub: ${x.fullName}, default ${x.defaultBranch}` : x.error }))).catch(report)}>Check connection</button></td>
              </tr>
            );
          })}</tbody></table>
        <form className="row" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void add({ owner: String(f.get("owner")), name: String(f.get("name")), defaultBranch: String(f.get("branch") || "main") }).catch(report); }}>
          <input name="owner" placeholder="owner" required /><input name="name" placeholder="repository" required /><input name="branch" placeholder="main" /><button>Connect</button>
        </form>
      </Section>

      <Section title="GitHub">
        <p>Read by polling: GitHub is the source of truth for branches, pull requests, checks and reviews. Last success {ago(settings.githubSync?.lastOkAt)}; failures in a row: {settings.githubSync?.consecutiveFailures ?? 0}{settings.githubSync?.lastError ? `; last error: ${settings.githubSync.lastError}` : ""}.</p>
        <button className="secondary" onClick={() => void syncNow({}).catch(report)}>Poll now</button>
      </Section>

      <Section title="Execution policy" aside={p.updatedBy ? <span className="muted small">changed by {p.updatedBy} {ago(p.updatedAt)}</span> : <span className="muted small">defaults</span>}>
        <form className="form policy" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void setPolicy({ maxAttempts: Number(f.get("maxAttempts")), leaseMinMs: Number(f.get("leaseMin")) * 1000, leaseMaxMs: Number(f.get("leaseMax")) * 1000 }).catch(report); }}>
          <label>Attempts per generation, before the work fails <input name="maxAttempts" type="number" min={1} max={20} defaultValue={p.maxAttempts} key={`a${p.maxAttempts}`} /></label>
          <label>Shortest lease a runner may take (s) <input name="leaseMin" type="number" min={1} max={3600} defaultValue={p.leaseMinMs / 1000} key={`m${p.leaseMinMs}`} /></label>
          <label>Longest lease (s): a crashed runner's work is re-claimable after at most this <input name="leaseMax" type="number" min={1} max={3600} defaultValue={p.leaseMaxMs / 1000} key={`x${p.leaseMaxMs}`} /></label>
          <button>Save policy</button>
        </form>
        <p className="muted small">Applies at the next claim. Leases, claims and attempt fencing are FeltKit's; Handoff only bounds them.</p>
      </Section>

      <Section title="Approval rules">
        <table><thead><tr><th>Action</th><th>Rule</th><th>Approver</th><th>Enforced at</th></tr></thead>
          <tbody>{settings.approvalRules.map((r) => <tr key={r.action}><td><code>{r.action}</code></td><td>{r.rule}</td><td>{r.approver}</td><td className="small">{r.enforcedAt}</td></tr>)}</tbody></table>
      </Section>

      <Section title="Credentials">
        <table><thead><tr><th>Reference</th><th>Held by</th><th>Used for</th></tr></thead>
          <tbody>{settings.credentials.map((c) => <tr key={c.ref}><td><code>{c.ref}</code></td><td>{c.holder}</td><td>{c.use}</td></tr>)}</tbody></table>
        <p className="muted small">References only. Values are never stored in Handoff records or shown.</p>
      </Section>

      <Section title="Runtime capability vocabulary">
        <p className="muted small">What a runner may declare for each control. Each runner declares its own values at heartbeat and claim (shown on Agents and on each work item); Handoff disables a control its runtime declares <code>none</code>.</p>
        <table><thead><tr><th>Control</th><th>Values a runtime may declare</th></tr></thead>
          <tbody>{Object.entries(settings.runtimeCapabilities as Record<string, readonly string[]>).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.map((x) => <code key={x} className="cap-val">{x}</code>)}</td></tr>)}</tbody></table>
      </Section>

      <Section title="Runner identity"><p>{settings.runnerIdentity}</p></Section>
    </div>
  );
}
