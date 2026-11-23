/**
 * Agents: what can do work (definitions), what is running it (runner processes, self-reported),
 * and what each runtime declares it can do when steered. Runner facts are asserted by the shared
 * runner-pool identity; nothing here authenticates an individual runner.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Badge, Section, Trust, ago } from "./ui";

const STALE_MS = 45_000;
const CAP_LABEL: Record<string, string> = { steer: "Updates", pause: "Pause", interrupt: "Interrupt", resume: "Resume", stop: "Stop", reconnect: "Reconnect to a session" };

export function Agents({ report }: { report: (e: unknown) => void }) {
  const agents = useQuery(api.admin.listAgents);
  const workers = useQuery(api.admin.listWorkers);
  const list = useQuery(api.work.list, {});
  const register = useMutation(api.admin.registerAgent);
  const setStatus = useMutation(api.admin.setAgentStatus);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 5_000); return () => clearInterval(t); }, []);
  const running = (list ?? []).filter((d) => ["dispatched", "running", "awaiting_approval"].includes(d.state));
  return (
    <div className="stack">
      <h2>Agents</h2>
      <Section title="Definitions" aside={<Trust trust="decided" />}>
        <table><thead><tr><th>Key</th><th>Name</th><th>Definition</th><th>Model</th><th>Status</th><th>Running</th><th /></tr></thead>
          <tbody>{agents?.map((a) => (
            <tr key={a.id}><td>{a.key}</td><td>{a.name}</td><td><code>{a.definition}</code></td><td>{a.model}</td><td><Badge state={a.status} /></td>
              <td>{running.filter((d) => d.agentKey === a.key).length}</td>
              <td><button className="secondary" onClick={() => { const reason = prompt("Reason"); if (reason) void setStatus({ key: a.key, status: a.status === "active" ? "suspended" : "active", reason }).catch(report); }}>{a.status === "active" ? "Suspend" : "Activate"}</button></td></tr>
          ))}</tbody></table>
        <details><summary>Register an agent (admin)</summary>
          <form className="form" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void register({ key: String(f.get("key")), name: String(f.get("name")), definition: String(f.get("definition")), model: String(f.get("model")) }).catch(report); }}>
            <label>Key <input name="key" required /></label><label>Name <input name="name" required /></label>
            <label>Definition (EVE agent directory) <input name="definition" defaultValue="eve:runner/agent" /></label><label>Model <input name="model" defaultValue="anthropic:claude-sonnet-5-5" /></label>
            <button>Register</button>
          </form>
        </details>
      </Section>

      <Section title={`Runners (${workers?.length ?? 0})`} aside={<Trust trust="asserted" />}>
        {workers?.length === 0 ? <p className="muted">No runner has sent a heartbeat. Start one with <code>node runner/src/runner.mjs</code>.</p> : (
          <table className="workers"><thead><tr><th>Instance</th><th>State</th><th>Runtime</th><th>Working on</th><th>Last heard</th><th>Capabilities</th></tr></thead>
            <tbody>{workers?.map((w) => {
              const stale = Date.now() - w.lastSeenAt > STALE_MS;
              const d = w.delegationId ? list?.find((x) => x.id === w.delegationId) : undefined;
              return (
                <tr key={w.id} data-instance={w.instance}>
                  <td><code>{w.instance}</code><div className="muted small">{w.sessionRef ? <>session <code title="The FeltKit session this runner's calls arrive on: observed by Handoff's server, revocable on its own with feltkit session revoke">{w.sessionRef.slice(0, 14)}</code></> : "no session ref"}</div></td>
                  <td><Badge state={w.sessionEnded ? `session ${w.sessionEnded.reason}` : stale ? "stale" : w.state} />{w.lastError && <div className="small danger-text">{w.lastError}</div>}</td>
                  <td>{w.runtime.name} {w.runtime.version}<div className="muted small">node {w.runtime.node}{w.runtime.model ? ` · ${w.runtime.model}` : ""}</div></td>
                  <td>{d ? <a href={`#work/${d.id}`}>#{d.number} {d.title}</a> : w.delegationId ? <code>{w.delegationId}</code> : <span className="muted">idle</span>}{w.session && <div className="muted small">session <code>{w.session}</code></div>}</td>
                  <td>{ago(w.lastSeenAt)}</td>
                  <td className="small">{Object.entries(w.capabilities as Record<string, string>).map(([k, v]) => <span key={k} className={`cap ${v === "none" ? "off" : ""}`} title={v}>{CAP_LABEL[k] ?? k}</span>)}</td>
                </tr>
              );
            })}</tbody></table>
        )}
        <p className="muted small">One trusted pool shares the <code>runner-pool</code> identity. Instance ids, runtime versions and capabilities are what each runner says about itself. The session column is observed: give each runner its own pool session and it can be revoked alone. It is still the same principal, so every runner can see every pool invocation; claims and leases keep them from acting on each other's attempts. A runner is shown stale after {STALE_MS / 1000} s without a heartbeat. Ownership of work is decided by FeltKit leases, not by this list.</p>
      </Section>
    </div>
  );
}
