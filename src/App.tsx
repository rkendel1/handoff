import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useConnectionState, useMutation, useAction, useQuery, useSession, type FeltKitClientError } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ThemeToggle } from "./theme";
import { AgentControl } from "./AgentControl";

type Route = { page: "desk" | "work" | "agents" | "settings"; id?: string };
const parse = (): Route => { const [page, id] = location.hash.replace(/^#\/?/, "").split("/"); return { page: (["work", "agents", "settings"].includes(page ?? "") ? page : "desk") as Route["page"], id }; };
const go = (hash: string) => { location.hash = hash; };
const ago = (t?: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago` : "never");
const err = (e: unknown) => (e as FeltKitClientError)?.message ?? String(e);

/**
 * FeltKit's own HTTP routes for decisions the platform owns (invocation approval, agent control).
 * Approval stays a person's platform decision: this UI only sends it, with the session's CSRF token.
 */
async function platform(path: string, body?: unknown): Promise<any> {
  const s = await (await fetch("/api/session", { credentials: "same-origin", headers: { "X-FeltKit-Session": "cookie" } })).json();
  const r = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie", ...(s.csrf ? { "X-FeltKit-CSRF": s.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

export function App() {
  const { session, signInAsDevUser, signOut } = useSession();
  const live = useConnectionState();
  const [route, setRoute] = useState(parse());
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { const f = () => setRoute(parse()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const tried = useRef(false);
  useEffect(() => { if (session && !session.principal && session.devUsers.length && !tried.current) { tried.current = true; void signInAsDevUser(session.devUsers[0]!.id); } }, [session, signInAsDevUser]);
  const report = (e: unknown) => setNotice(err(e));
  const me = session?.principal?.id ?? null;
  const nav = [["desk", "Desk"], ["work", "Work"], ["agents", "Agents"], ["settings", "Settings"]] as const;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-name">Handoff</span>{session && !session.environment.production && <span className="env">{session.environment.name}</span>}</div>
        <nav className="nav">{nav.map(([p, label]) => <a key={p} href={`#${p}`} className={route.page === p ? "active" : ""}>{label}</a>)}</nav>
        <div className="topbar-right">
          <span className={`live ${live ? "on" : ""}`}><span className="dot" /> {live ? "Live" : "Connecting"}</span>
          {session && session.devUsers.length > 0 && (
            <select value={me ?? ""} aria-label="Signed in as" onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(report) : signOut())}>
              <option value="">Signed out</option>
              {session.devUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <ThemeToggle />
        </div>
      </header>
      {notice && <div className="notice" role="alert" onClick={() => setNotice(null)}>{notice}</div>}
      <main className="main">
        {!me ? <p>Sign in to continue.</p>
          : route.page === "work" && route.id ? <WorkDetail id={route.id} me={me} report={report} />
          : route.page === "work" ? <WorkList report={report} />
          : route.page === "agents" ? <Agents report={report} />
          : route.page === "settings" ? <Settings report={report} />
          : <Desk />}
      </main>
    </div>
  );
}

function Desk() {
  const desk = useQuery(api.work.desk);
  if (!desk) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <Section title="Needs you">
        {desk.needs.length === 0 ? <p className="muted">Nothing needs you. <a href="#work">Delegate something →</a></p>
          : <ul className="rows">{desk.needs.map((n) => <li key={n.id}><a href={`#work/${n.id}`}>#{n.number} {n.title}</a><span className="muted">{n.reason}</span></li>)}</ul>}
      </Section>
      <Section title="In flight">
        {desk.moving.length === 0 ? <p className="muted">No work is running.</p>
          : <ul className="rows">{desk.moving.map((m) => <li key={m.id}><a href={`#work/${m.id}`}>#{m.number} {m.title}</a><Badge state={m.state} /><span className="muted">{m.agentKey} · updated {ago(m.updatedAt)}</span></li>)}</ul>}
      </Section>
      <Section title="Recently finished">
        <ul className="rows">{desk.done.map((d) => <li key={d.id}><a href={`#work/${d.id}`}>#{d.number} {d.title}</a><Badge state={d.state} /></li>)}</ul>
      </Section>
      <p className="muted small">GitHub last read {ago(desk.githubSync?.lastOkAt)}{desk.githubSync?.lastError ? ` · last error: ${desk.githubSync.lastError}` : ""}</p>
    </div>
  );
}

function WorkList({ report }: { report: (e: unknown) => void }) {
  const list = useQuery(api.work.list, {});
  const repos = useQuery(api.admin.listRepositories);
  const agents = useQuery(api.admin.listAgents);
  const create = useMutation(api.work.create);
  const assign = useMutation(api.work.assign);
  const importIssue = useAction(api.work.importIssue);
  const [open, setOpen] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const repositoryId = String(f.get("repo"));
      const issue = Number(f.get("issue") || 0);
      const id = issue ? await importIssue.run({ repositoryId, issueNumber: issue }) : await create({ title: String(f.get("title")), objective: String(f.get("objective")), criteria: String(f.get("criteria") || "").split("\n").map((s) => s.trim()).filter(Boolean), repositoryId });
      const agentKey = String(f.get("agent") || "");
      if (agentKey) await assign({ id, agentKey });
      setOpen(false); go(`work/${id}`);
    } catch (x) { report(x); }
  };
  return (
    <div className="stack">
      <div className="row"><h2>Work</h2><button onClick={() => setOpen(!open)}>New work</button></div>
      {open && (
        <form className="card form" onSubmit={submit}>
          {repos?.length === 0 && <p>Connect a repository in <a href="#settings">Settings</a> first.</p>}
          <label>Repository <select name="repo" required>{repos?.map((r) => <option key={r.id} value={r.id}>{r.owner}/{r.name}</option>)}</select></label>
          <label>Import GitHub issue # (optional; title and body come from GitHub) <input name="issue" type="number" min="1" /></label>
          <label>Title <input name="title" minLength={3} /></label>
          <label>Objective <textarea name="objective" rows={4} /></label>
          <label>Acceptance criteria (one per line; shown to the agent and the reviewer) <textarea name="criteria" rows={3} /></label>
          <label>Agent (optional: without one the work stays a draft) <select name="agent"><option value="">—</option>{agents?.filter((a) => a.status === "active").map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}</select></label>
          <button type="submit">Delegate</button>
        </form>
      )}
      {list?.length === 0 ? <p className="muted">Delegate your first piece of work.</p> : (
        <table><thead><tr><th>#</th><th>Title</th><th>State</th><th>Agent</th><th>Requested by</th><th>Updated</th></tr></thead>
          <tbody>{list?.map((d) => <tr key={d.id} onClick={() => go(`work/${d.id}`)}><td>{d.number}</td><td>{d.title}</td><td><Badge state={d.state} /></td><td>{d.agentKey ?? "—"}</td><td>{d.requestedBy}</td><td>{ago(d.updatedAt)}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function WorkDetail({ id, me, report }: { id: string; me: string; report: (e: unknown) => void }) {
  const detail = useQuery(api.work.detail, { id });
  const agents = useQuery(api.admin.listAgents);
  const assign = useMutation(api.work.assign);
  const cancel = useMutation(api.work.cancel);
  const review = useMutation(api.work.review);
  const verify = useMutation(api.github.verify);
  const taskId = detail?.delegation.agentTaskId;
  if (!detail) return <p className="muted">Loading…</p>;
  const d = detail.delegation;
  const inv = detail.invocation as any;
  const approval = inv?.approval;
  const mine = d.requestedBy === me;
  const terminal = ["accepted", "rejected", "cancelled"].includes(d.state);
  const latestPr = [...detail.facts].reverse().find((f) => f.kind === "pull_request");
  const act = (p: Promise<unknown>) => p.catch(report);
  return (
    <div className="stack">
      <div className="row"><h2>#{d.number} {d.title}</h2><Badge state={d.state} /></div>
      <Section title="Request">
        <p className="pre">{d.objective}</p>
        {d.criteria.length > 0 && <ul>{d.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul>}
        <p className="muted">{detail.repository ? `${detail.repository.owner}/${detail.repository.name}` : "?"} @ {d.baseBranch} → <code>{d.branch}</code> · requested by {d.requestedBy}{d.issueNumber ? ` · issue #${d.issueNumber}` : ""} · generation {d.generation}</p>
        {d.state === "draft" && <form onSubmit={(e) => { e.preventDefault(); void act(assign({ id, agentKey: String(new FormData(e.currentTarget).get("agent")) })); }}><select name="agent">{agents?.filter((a) => a.status === "active").map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}</select> <button>Assign</button></form>}
        {!terminal && mine && <button className="danger" onClick={() => { const reason = prompt("Why cancel? The runner is stopped at its next step; work already pushed stays on the branch."); if (reason) void act(cancel({ id, reason })); }}>Cancel</button>}
      </Section>

      {approval && !approval.decision && !approval.rejection && (
        <Section title="Approval needed">
          <p>The runner asks to <strong>open a pull request</strong> for <code>{approval.input?.branch}</code> at <code>{String(approval.input?.headSha).slice(0, 12)}</code>.</p>
          {mine ? <div className="row">
            <button onClick={() => void act(platform(`/api/invocations/${d.invocationId}/approve`, { digest: approval.digest }))}>Approve</button>
            <button className="secondary" onClick={() => { const reason = prompt("Reason for rejecting"); if (reason) void act(platform(`/api/invocations/${d.invocationId}/reject`, { reason })); }}>Reject</button>
          </div> : <p className="muted">Only {d.requestedBy}, who delegated this work, can approve it.</p>}
        </Section>
      )}

      {taskId && (
        <Section title="Steer the agent">
          <AgentControl taskId={taskId} canStop={mine && !terminal} report={report} onStop={async () => {
            await platform(`/api/agent/tasks/${taskId}/control/stop`, { reason: "stopped from Handoff" }).catch(() => undefined);
            if (!terminal) await cancel({ id, reason: "Stopped from the agent controls" });
          }} />
        </Section>
      )}

      {(d.report || latestPr) && (
        <Section title="Result">
          <table><thead><tr><th>The agent says (claim)</th><th>Observed on GitHub (fact)</th></tr></thead><tbody><tr>
            <td>{d.report ? <><p className="pre">{d.report.summary}</p><p>head <code>{d.report.headSha.slice(0, 12)}</code> · by {d.report.instance} (asserted)</p></> : "—"}</td>
            <td>{latestPr ? <><p>PR #{latestPr.prNumber} · {latestPr.state} {latestPr.url ? <a href={latestPr.url} target="_blank" rel="noreferrer">open</a> : null}</p><p>head <code>{latestPr.headSha?.slice(0, 12)}</code> {d.report ? (latestPr.headSha === d.report.headSha ? "✓ matches the report" : "✗ differs from the report") : ""}</p><p className="muted">observed {ago(latestPr.observedAt)}</p></> : "No pull request observed"}</td>
          </tr></tbody></table>
          <div className="row">
            <button className="secondary" onClick={() => void act(verify({ delegationId: id }))}>Check GitHub now</button>
            <button disabled={d.state !== "verified"} title={d.state !== "verified" ? "Accept needs a verified result: GitHub must show the reported commit" : ""} onClick={() => { const note = prompt("Acceptance note"); if (note) void act(review({ id, decision: "accepted", note })); }}>Accept</button>
            <button className="secondary" disabled={!["reported", "verified", "failed"].includes(d.state)} onClick={() => { const note = prompt("What should change? (a new attempt starts with this note)"); if (note) void act(review({ id, decision: "returned", note })); }}>Request changes</button>
            <button className="danger" disabled={terminal} onClick={() => { const note = prompt("Why reject?"); if (note) void act(review({ id, decision: "rejected", note })); }}>Reject</button>
          </div>
        </Section>
      )}

      <Section title={`Run (${detail.events.length} observations, reported by the runner)`}>
        {inv && <p className="muted">FeltKit invocation {inv.state} · attempts: {inv.executions?.[0]?.attempts?.map((a: any) => `${a.number}:${a.outcome}${a.worker?.id ? ` (${a.worker.id})` : ""}`).join(", ") || "none"}</p>}
        <ol className="events">{detail.events.slice(-200).map((e) => <li key={`${e.attempt}-${e.seq}`} className={`ev ${e.kind}`}><span className="muted">{e.instance} #{e.seq}</span> <span className="kind">{e.kind}</span> {e.text}</li>)}</ol>
      </Section>

      <Section title="History">
        <ol className="history">{detail.history.map((h) => <li key={h.id}><span className={`src ${String((h.data as any)?.source ?? "")}`}>{String((h.data as any)?.source ?? "")}</span> <strong>{h.type}</strong> <span className="muted">by {h.actor} · {new Date(h.at).toLocaleString()}</span> <code className="small">{JSON.stringify(h.data)}</code></li>)}</ol>
      </Section>
    </div>
  );
}

function Agents({ report }: { report: (e: unknown) => void }) {
  const agents = useQuery(api.admin.listAgents);
  const register = useMutation(api.admin.registerAgent);
  const setStatus = useMutation(api.admin.setAgentStatus);
  return (
    <div className="stack">
      <h2>Agents</h2>
      <table><thead><tr><th>Key</th><th>Name</th><th>Definition</th><th>Model</th><th>Status</th><th /></tr></thead>
        <tbody>{agents?.map((a) => <tr key={a.id}><td>{a.key}</td><td>{a.name}</td><td><code>{a.definition}</code></td><td>{a.model}</td><td><Badge state={a.status} /></td><td><button className="secondary" onClick={() => { const reason = prompt("Reason"); if (reason) void setStatus({ key: a.key, status: a.status === "active" ? "suspended" : "active", reason }).catch(report); }}>{a.status === "active" ? "Suspend" : "Activate"}</button></td></tr>)}</tbody></table>
      <form className="card form" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void register({ key: String(f.get("key")), name: String(f.get("name")), definition: String(f.get("definition")), model: String(f.get("model")) }).catch(report); }}>
        <strong>Register an agent (admin)</strong>
        <label>Key <input name="key" required /></label><label>Name <input name="name" required /></label>
        <label>Definition (EVE agent directory) <input name="definition" defaultValue="eve:runner/agent" /></label><label>Model <input name="model" defaultValue="anthropic:claude-sonnet-5-5" /></label>
        <button>Register</button>
      </form>
      <Section title="Runners">
        <p>One trusted runner pool shares the <code>runner-pool</code> identity. Runner instance ids are recorded as asserted evidence; runners cannot be attributed or revoked individually. Revoking the pool's session stops all of them.</p>
      </Section>
    </div>
  );
}

function Settings({ report }: { report: (e: unknown) => void }) {
  const repos = useQuery(api.admin.listRepositories);
  const settings = useQuery(api.admin.settings);
  const add = useMutation(api.admin.addRepository);
  const syncNow = useMutation(api.github.syncNow);
  return (
    <div className="stack">
      <h2>Settings</h2>
      <Section title="Repositories">
        <ul className="rows">{repos?.map((r) => <li key={r.id}>{r.owner}/{r.name} <span className="muted">default {r.defaultBranch}</span></li>)}</ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void add({ owner: String(f.get("owner")), name: String(f.get("name")), defaultBranch: String(f.get("branch") || "main") }).catch(report); }}>
          <input name="owner" placeholder="owner" required /><input name="name" placeholder="repository" required /><input name="branch" placeholder="main" /><button>Connect</button>
        </form>
      </Section>
      <Section title="GitHub">
        <p>Read by polling (GitHub webhooks are not accepted by the platform's inbound contract). Last success {ago(settings?.githubSync?.lastOkAt)}; failures in a row: {settings?.githubSync?.consecutiveFailures ?? 0}{settings?.githubSync?.lastError ? `; last error: ${settings.githubSync.lastError}` : ""}.</p>
        <button className="secondary" onClick={() => void syncNow({}).catch(report)}>Poll now</button>
        <p className="muted">The GitHub credential is a FeltKit credential reference (<code>credential-ref:github</code>); its value is never stored or shown.</p>
      </Section>
      <Section title="Runner identity"><p>{settings?.runnerIdentity}</p></Section>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => <section className="card"><h3>{title}</h3>{children}</section>;
const Badge = ({ state }: { state: string }) => <span className={`badge ${state}`}>{state.replace(/_/g, " ")}</span>;
