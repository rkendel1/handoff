/**
 * The Desk: what needs attention, and why. Every row is a durable delegation, linked to its evidence.
 * Derived from records (work:desk); nothing here is stored or computed in the browser.
 */
import { useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Badge, Section, ago } from "./ui";

type Row = { id: string; number: number; title: string; state: string; agentKey: string | null; requestedBy: string; mine: boolean; updatedAt: number; reason: string };

const GROUPS: Array<{ key: "awaitingApproval" | "waitingForInput" | "failedOrUncertain" | "needsReview" | "awaitingAssignment" | "active" | "recentlyAccepted"; title: string; empty: string; tone?: string }> = [
  { key: "awaitingApproval", title: "Awaiting your approval", empty: "No approvals pending.", tone: "attention" },
  { key: "waitingForInput", title: "Waiting for a person", empty: "No agent is paused or interrupted.", tone: "attention" },
  { key: "failedOrUncertain", title: "Failed or uncertain", empty: "Nothing failed or uncertain.", tone: "danger" },
  { key: "needsReview", title: "Review", empty: "Nothing to review.", tone: "attention" },
  { key: "awaitingAssignment", title: "Awaiting assignment", empty: "Every draft has an agent." },
  { key: "active", title: "Active", empty: "No work is running." },
  { key: "recentlyAccepted", title: "Recently accepted", empty: "Nothing accepted yet." },
];

export function Desk() {
  const desk = useQuery(api.work.desk);
  if (!desk) return <p className="muted">Loading…</p>;
  const attention = (["awaitingApproval", "waitingForInput", "failedOrUncertain", "needsReview"] as const).reduce((n, k) => n + desk[k].length, 0);
  return (
    <div className="stack">
      <div className="row"><h2>Desk</h2><span className="muted">{attention === 0 ? "Nothing needs attention." : `${attention} item${attention === 1 ? "" : "s"} need attention.`}</span><a className="push" href="#work">All work →</a></div>
      <div className="desk-grid">
        {GROUPS.map((g) => (
          <Section key={g.key} title={`${g.title} (${desk[g.key].length})`} aside={<span className={`tone ${g.tone ?? ""}`} />}>
            {desk[g.key].length === 0 ? <p className="muted">{g.empty}</p> : (
              <ul className="rows" data-group={g.key}>
                {(desk[g.key] as Row[]).map((r) => (
                  <li key={r.id}>
                    <a href={`#work/${r.id}`}>#{r.number} {r.title}</a>
                    <Badge state={r.state} />
                    <span className="muted">{r.reason}</span>
                    <span className="muted small">{r.mine ? "yours" : `by ${r.requestedBy}`} · {ago(r.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ))}
      </div>
      <p className="muted small">GitHub last read {ago(desk.githubSync?.lastOkAt)}{desk.githubSync?.lastError ? ` · last error: ${desk.githubSync.lastError}` : ""}. Polling; GitHub is the source of truth for branches, pull requests and checks.</p>
    </div>
  );
}
