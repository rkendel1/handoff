import type { ReactNode } from "react";
import type { FeltKitClientError } from "@feltdb/feltkit/react";

export const ago = (t?: number | null) => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
export const err = (e: unknown) => (e as FeltKitClientError)?.message ?? String(e);
export const go = (hash: string) => { location.hash = hash; };
export const short = (sha?: string | null) => (sha ? sha.slice(0, 10) : "—");

/**
 * FeltKit's own HTTP routes for decisions the platform owns (invocation approval, agent control).
 * The browser only sends a person's decision with their session's CSRF token; it holds no other authority.
 */
export async function platform(path: string, body?: unknown): Promise<any> {
  const s = await (await fetch("/api/session", { credentials: "same-origin", headers: { "X-FeltKit-Session": "cookie" } })).json();
  const r = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie", ...(s.csrf ? { "X-FeltKit-CSRF": s.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

export const Section = ({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) => (
  <section className="card"><div className="card-head"><h3>{title}</h3>{aside}</div>{children}</section>
);
export const Badge = ({ state }: { state: string }) => <span className={`badge ${state}`}>{state.replace(/_/g, " ")}</span>;

/** How far to trust an entry: who said it, and whether anything independent confirmed it. */
const TRUST: Record<string, { label: string; title: string }> = {
  reported: { label: "Reported by runner", title: "The runner's statement. Not verified by Handoff." },
  observed: { label: "Observed on GitHub", title: "Handoff read this from GitHub itself, at the time shown." },
  verified: { label: "Verified", title: "A GitHub fact matched the runner's claim." },
  decided: { label: "Person", title: "A person's recorded decision." },
  system: { label: "Handoff", title: "Recorded by Handoff or FeltKit." },
  asserted: { label: "Asserted", title: "Self-reported by the runner pool's shared identity; not authenticated." },
};
export const Trust = ({ trust }: { trust: string }) => <span className={`trust ${trust}`} title={TRUST[trust]?.title}>{TRUST[trust]?.label ?? trust}</span>;
