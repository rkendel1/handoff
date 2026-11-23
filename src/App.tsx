import { useEffect, useRef, useState } from "react";
import { useConnectionState, useSession } from "@feltdb/feltkit/react";
import { ThemeToggle } from "./theme";
import { Desk } from "./Desk";
import { WorkList } from "./WorkList";
import { WorkDetail } from "./WorkDetail";
import { Agents } from "./Agents";
import { Settings } from "./Settings";
import { err } from "./ui";

type Route = { page: "desk" | "work" | "agents" | "settings"; id?: string };
const parse = (): Route => { const [page, id] = location.hash.replace(/^#\/?/, "").split("/"); return { page: (["work", "agents", "settings"].includes(page ?? "") ? page : "desk") as Route["page"], id }; };

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
          : route.page === "work" && route.id ? <WorkDetail key={route.id} id={route.id} me={me} report={report} />
          : route.page === "work" ? <WorkList report={report} />
          : route.page === "agents" ? <Agents report={report} />
          : route.page === "settings" ? <Settings report={report} />
          : <Desk />}
      </main>
    </div>
  );
}
