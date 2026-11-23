/** Work: every delegation, and the form that creates one (or imports a GitHub issue). */
import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Badge, ago, go } from "./ui";

export function WorkList({ report }: { report: (e: unknown) => void }) {
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
