/**
 * Work: one delegation, from request through execution, intervention, review and acceptance.
 * Layers stay distinct: the delegation (the request), generations and attempts (FeltKit claims),
 * runtime sessions and turns (EVE, as the runner reports them), activity (runner reports),
 * external facts (GitHub, read by Handoff) and decisions (people).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { AgentControl } from "./AgentControl";
import { Badge, Section, Trust, ago, platform, short } from "./ui";

const STEPS = [
  ["draft", "Requested"], ["queued", "Assigned"], ["running", "Running"], ["awaiting_approval", "Approval"], ["reported", "Reported"], ["verified", "Verified on GitHub"], ["accepted", "Accepted"],
] as const;
const ORDER: Record<string, number> = { draft: 0, queued: 1, dispatched: 1, running: 2, awaiting_approval: 3, reported: 4, verified: 5, accepted: 6 };

export function WorkDetail({ id, me, report }: { id: string; me: string; report: (e: unknown) => void }) {
  const detail = useQuery(api.work.detail, { id });
  const tl = useQuery(api.work.timeline, { id });
  const agents = useQuery(api.admin.listAgents);
  const assign = useMutation(api.work.assign);
  const cancel = useMutation(api.work.cancel);
  const review = useMutation(api.work.review);
  const readGitHub = useMutation(api.github.observeSourceControlNow);
  const verify = useMutation(api.github.verify);
  const recordDecision = useMutation(api.work.recordApprovalDecision);
  const [layer, setLayer] = useState<string>("all");
  const [openAttempt, setOpenAttempt] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => p.catch(report);
  const latest = useMemo(() => {
    const byKind: Record<string, any> = {};
    for (const f of [...(detail?.facts ?? [])].sort((a, b) => a.observedAt - b.observedAt)) byKind[f.kind] = f;
    return byKind;
  }, [detail?.facts]);
  if (!detail || !tl) return <p className="muted">Loading…</p>;
  const d = detail.delegation;
  const inv = detail.invocation as any;
  const approval = inv?.approval;
  const mine = d.requestedBy === me;
  const terminal = ["accepted", "rejected", "cancelled"].includes(d.state);
  const pr = latest.pull_request;
  const caps = (d.runtime?.capabilities ?? {}) as Record<string, string>;
  const step = ORDER[d.state] ?? -1;
  const entries = tl.entries.filter((e: any) => layer === "all" || e.layer === layer || (layer === "decision" && e.trust === "decided"));

  return (
    <div className="stack">
      <div className="row"><h2>#{d.number} {d.title}</h2><Badge state={d.state} /><span className="muted">generation {d.generation} · <code>{d.branch}</code></span></div>
      <ol className="stepper" aria-label="Lifecycle">
        {STEPS.map(([s, label], i) => <li key={s} className={i < step ? "done" : i === step ? "current" : ""}>{label}</li>)}
        {["failed", "cancelled", "rejected"].includes(d.state) && <li className="current off">{d.state}</li>}
      </ol>

      <Section title="Request" aside={<Trust trust="decided" />}>
        <p className="pre">{d.objective}</p>
        {d.criteria.length > 0 && <><strong className="small">Acceptance criteria</strong><ul>{d.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
        <p className="muted">{detail.repository ? `${detail.repository.owner}/${detail.repository.name}` : "?"} @ {d.baseBranch} · requested by {d.requestedBy}{d.issueNumber ? ` · GitHub issue #${d.issueNumber}` : ""}{d.agentKey ? ` · agent ${d.agentKey}` : ""}</p>
        {d.state === "draft" && <form className="row" onSubmit={(e) => { e.preventDefault(); void act(assign({ id, agentKey: String(new FormData(e.currentTarget).get("agent")) })); }}><select name="agent">{agents?.filter((a) => a.status === "active").map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}</select><button>Assign</button></form>}
        {!terminal && mine && <button className="danger" onClick={() => { const reason = prompt("Why cancel? The runner stops at its next step; work already pushed stays on the branch."); if (reason) void act(cancel({ id, reason })); }}>Cancel delegation</button>}
      </Section>

      {approval && !approval.decision && !approval.rejection && (
        <Section title="Approval needed" aside={<span className="tone attention" />}>
          <p>The runner asks to <strong>open a pull request</strong> for <code>{approval.input?.branch}</code> at <code>{short(approval.input?.headSha)}</code>. Approving lets Handoff open it once; it never merges.</p>
          <p className="muted small">Digest {String(approval.digest).slice(0, 18)}… · requested by {approval.requestedBy?.id} · expires {new Date(approval.expiresAt).toLocaleString()}</p>
          {mine ? <div className="row">
            <button onClick={() => void act(platform(`/api/invocations/${d.invocationId}/approve`, { digest: approval.digest }).then(() => recordDecision({ id })))}>Approve</button>
            <button className="secondary" onClick={() => { const reason = prompt("Reason for rejecting"); if (reason) void act(platform(`/api/invocations/${d.invocationId}/reject`, { reason }).then(() => recordDecision({ id }))); }}>Reject</button>
          </div> : <p className="muted">Only {d.requestedBy}, who delegated this work, can approve it (FeltKit enforces this).</p>}
        </Section>
      )}

      {d.agentTaskId && (
        <Section title="Steer the agent" aside={d.runtime ? <span className="muted small">runtime capabilities declared by {d.runtime.instance} <Trust trust="asserted" /></span> : null}>
          <AgentControl taskId={d.agentTaskId} capabilities={caps} canStop={mine && !terminal} report={report} onStop={async () => {
            await platform(`/api/agent/tasks/${d.agentTaskId}/control/stop`, { reason: "stopped from Handoff" }).catch(() => undefined);
            if (!terminal) await cancel({ id, reason: "Stopped from the agent controls" });
          }} />
        </Section>
      )}

      <Section title={`Execution (${tl.attempts.length} attempt${tl.attempts.length === 1 ? "" : "s"})`} aside={<span className="muted small">attempts and leases: FeltKit · sessions and turns: <Trust trust="reported" /></span>}>
        {tl.attempts.length === 0 ? <p className="muted">No attempt yet. {d.state === "queued" ? "Waiting for a runner to claim it." : ""}</p> : (
          <ol className="attempts">
            {tl.attempts.map((a: any, i: number) => {
              const outcome = inv?.executions?.[0]?.attempts?.find((x: any) => x.id === a.attempt)?.outcome;
              return (
                <li key={a.attempt + i}>
                  <button className="link" onClick={() => setOpenAttempt(openAttempt === a.attempt ? null : a.attempt)} aria-expanded={openAttempt === a.attempt}>
                    Attempt {a.attempt.split("_").pop()} · {a.how === "attempt.takeover" ? "took over after an uncertain attempt" : a.how === "approval.resumed" ? "resumed after approval" : "started"}
                  </button>
                  {outcome && <Badge state={outcome} />}
                  <span className="muted small">runner <code>{a.instance}</code> <Trust trust="asserted" /> · {new Date(a.at).toLocaleTimeString()} · {a.events} event(s)</span>
                  {a.previous?.length > 0 && <div className="muted small">previous: {a.previous.map((p: any) => `${p.attempt.split("_").pop()} ${p.outcome}`).join(", ")}</div>}
                  {a.sessions.map((s: any) => <div key={s.session} className="small session">EVE session <code>{s.session}</code> · {s.turns.map((t: any) => `${t.turn} (${t.events})`).join(" · ")}</div>)}
                  {openAttempt === a.attempt && (
                    <ol className="events">{detail.events.filter((e) => e.attempt === a.attempt).map((e) => (
                      <li key={e.seq} className={`ev ${e.kind} ${e.status ?? ""}`}><span className="kind">{e.kind}</span>{e.status && <Badge state={e.status} />} {e.text}<span className="muted small"> {e.turn ?? ""}</span></li>
                    ))}</ol>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <Section title="Source control" aside={<span className="row small"><Trust trust="observed" /><button className="secondary" onClick={() => void act(readGitHub({ delegationId: id }))}>Read GitHub now</button></span>}>
        {!pr && !latest.diff ? <p className="muted">Nothing observed on GitHub for <code>{d.branch}</code> yet.</p> : (
          <div className="sc-grid">
            <div>
              <h4>Pull request</h4>
              {pr ? <p>#{pr.prNumber} · <Badge state={pr.state} /> {pr.url && <a href={pr.url} target="_blank" rel="noreferrer">open on GitHub</a>}<br /><span className="muted small">head <code>{short(pr.headSha)}</code> · observed {ago(pr.observedAt)}</span></p> : <p className="muted">No pull request.</p>}
              <h4>Checks</h4>
              {latest.checks ? <p><Badge state={latest.checks.state} /> <span className="muted small">{(latest.checks.detail?.runs ?? []).map((r: any) => `${r.name}: ${r.conclusion ?? r.status}`).join(" · ")} · observed {ago(latest.checks.observedAt)}</span></p> : <p className="muted">Not read yet.</p>}
              <h4>Reviews</h4>
              {latest.reviews ? <p><Badge state={latest.reviews.state} /> <span className="muted small">{(latest.reviews.detail?.reviews ?? []).map((r: any) => `${r.by ?? "?"}: ${r.state}`).join(" · ") || "none"}</span></p> : <p className="muted">Not read yet.</p>}
              <h4>Commits</h4>
              {latest.commits ? <ul className="small">{(latest.commits.detail?.commits ?? []).map((c: any) => <li key={c.sha}><code>{short(c.sha)}</code> {c.message}</li>)}</ul> : <p className="muted">Not read yet.</p>}
            </div>
            <div>
              <h4>Changed files {latest.diff ? `(${(latest.diff.detail?.files ?? []).length})` : ""}</h4>
              {latest.diff ? (latest.diff.detail?.files ?? []).map((f: any) => (
                <details key={f.filename} className="file">
                  <summary><code>{f.filename}</code> <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></summary>
                  {f.patch ? <pre className="diff">{f.patch.split("\n").map((l: string, i: number) => <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}{f.truncated ? "… (truncated; open the PR for the full diff)" : ""}</pre> : <p className="muted small">No patch (binary or too large).</p>}
                </details>
              )) : <p className="muted">Not read yet.</p>}
              {latest.diff && <p className="muted small">base <code>{short(latest.diff.detail?.base)}</code> → head <code>{short(latest.diff.detail?.head)}</code> · observed {ago(latest.diff.observedAt)}</p>}
            </div>
          </div>
        )}
      </Section>

      {(d.report || pr) && (
        <Section title="Result and review">
          <table className="claims"><thead><tr><th>The runner says <Trust trust="reported" /></th><th>GitHub shows <Trust trust="observed" /></th></tr></thead><tbody><tr>
            <td>{d.report ? <><p className="pre">{d.report.summary}</p><p>head <code>{short(d.report.headSha)}</code> · from <code>{d.report.instance}</code> <Trust trust="asserted" /></p></> : "No report yet."}</td>
            <td>{pr ? <><p>PR #{pr.prNumber} head <code>{short(pr.headSha)}</code></p><p>{d.report ? (pr.headSha === d.report.headSha ? "✓ matches the report" : "✗ differs from the report") : ""}</p>{d.verified && <p><Trust trust="verified" /> at {new Date(d.verified.at).toLocaleString()}</p>}</> : "No pull request observed."}</td>
          </tr></tbody></table>
          <div className="row">
            <button className="secondary" onClick={() => void act(verify({ delegationId: id }))}>Verify now</button>
            <button disabled={d.state !== "verified"} title={d.state !== "verified" ? "Accept needs a verified result: GitHub must show the reported commit" : ""} onClick={() => { const note = prompt("Acceptance note"); if (note) void act(review({ id, decision: "accepted", note })); }}>Accept</button>
            <button className="secondary" disabled={!["reported", "verified", "failed"].includes(d.state)} onClick={() => { const note = prompt("What should change? A new generation starts with this note."); if (note) void act(review({ id, decision: "returned", note })); }}>Request changes</button>
            <button className="danger" disabled={terminal} onClick={() => { const note = prompt("Why reject?"); if (note) void act(review({ id, decision: "rejected", note })); }}>Reject</button>
          </div>
          {d.review && <p className="small">Decision: <Badge state={d.review.decision} /> by {d.review.by} · {d.review.note}</p>}
        </Section>
      )}

      <Section title="Timeline" aside={<div className="chips" role="group" aria-label="Filter timeline">{["all", "decision", "attempt", "session", "activity", "fact", "evidence", "approval"].map((l) => <button key={l} className={`chip ${layer === l ? "on" : ""}`} onClick={() => setLayer(l)}>{l}</button>)}</div>}>
        <ol className="timeline">
          {entries.map((e: any) => (
            <li key={e.ref} className={`tl ${e.layer}`}>
              <span className="when muted small">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="layer">{e.layer}</span>
              <Trust trust={e.trust} />
              <span className="what">{e.layer === "activity" ? <>{(e.detail as any).text}{(e.detail as any).status ? <> <Badge state={(e.detail as any).status} /></> : null}</> : e.title}</span>
              {e.layer !== "activity" && <code className="small detail">{JSON.stringify(e.detail)}</code>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
