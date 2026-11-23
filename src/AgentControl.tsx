/**
 * Steering a running agent, on FeltKit agent control (published 0.3.36+; Handoff pins 0.3.37).
 *
 * Everything here is FeltKit's own lifecycle, called over its HTTP surface as the signed-in person:
 *   signal     "an update is coming": the agent keeps working (first keystroke in the composer)
 *   submit     the update, filling that same instruction; received now, taken at the agent's next checkpoint
 *   withdraw   the composer was emptied before sending
 *   pause / resume / interrupt / stop
 * State is FeltKit's level-triggered SSE stream (each frame is the whole state), never polled or guessed.
 * Stop also cancels the delegation (only the delegator may), so no further authorized work happens.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";

type Instruction = { instructionId: string; state: string; from: string; text?: string; resolution?: { by: string; note: string } };
export type Control = { phase: string; mode: "running" | "paused" | "interrupted"; reason: string | null; signaled: number; instructions: Instruction[] };

async function op(taskId: string, name: string, body: Record<string, unknown> = {}) {
  const s = await (await fetch("/api/session", { credentials: "same-origin", headers: { "X-FeltKit-Session": "cookie" } })).json();
  const r = await fetch(`/api/agent/tasks/${taskId}/control/${name}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-FeltKit-Session": "cookie", ...(s.csrf ? { "X-FeltKit-CSRF": s.csrf } : {}) }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
}

/** Live control state from FeltKit's SSE stream (`event: control`, the whole state each time). */
export function useAgentControl(taskId: string | undefined) {
  const [control, setControl] = useState<Control | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId) return;
    const es = new EventSource(`/api/agent/tasks/${taskId}/control/events`, { withCredentials: true });
    es.addEventListener("control", (e) => { setControl(JSON.parse((e as MessageEvent).data).control); setError(null); });
    es.addEventListener("error", (e) => { const d = (e as MessageEvent).data; if (d) setError(JSON.parse(d).error?.message ?? "stream error"); });
    return () => es.close();
  }, [taskId]);
  return { control, error };
}

const Icon = {
  pencil: <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />,
  pause: <path d="M6 5h4v14H6zM14 5h4v14h-4z" />,
  play: <path d="M7 5v14l12-7z" />,
  bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6z" />,
  stop: <path d="M6 6h12v12H6z" />,
  up: <path d="M12 4 5 11l1.4 1.4L11 7.8V20h2V7.8l4.6 4.6L19 11z" />,
};
const Svg = ({ d }: { d: ReactElement }) => <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">{d}</svg>;

function Btn({ kind, icon, label, showLabel, disabled, onClick, title }: { kind: "primary" | "plain" | "danger"; icon: ReactElement; label: string; showLabel?: boolean; disabled?: boolean; onClick?: () => void; title?: string }) {
  return (
    <button type="button" className={`ctl ${kind}${showLabel ? " labelled" : ""}`} aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}>
      <Svg d={icon} />{showLabel && <span>{label}</span>}
    </button>
  );
}

/** The control bar and the update composer, for one agent task. */
export function AgentControl({ taskId, canStop, onStop, report }: { taskId: string; canStop: boolean; onStop: () => Promise<unknown>; report: (e: unknown) => void }) {
  const { control, error } = useAgentControl(taskId);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null); // our signaled instruction
  const signaling = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const phase = control?.phase ?? "running";
  const stopped = phase === "stopped" || phase === "completed";
  const mode = control?.mode ?? "running";
  const run = (p: Promise<unknown>) => p.catch(report);

  const signal = async () => {
    if (pending || signaling.current || stopped) return;
    signaling.current = true;
    try { const r = await op(taskId, "signal", { note: "typing an update" }); setPending(r.instruction.instructionId); } catch (e) { report(e); } finally { signaling.current = false; }
  };
  const change = (v: string) => {
    setText(v);
    if (v.trim() && !pending) void signal();
    if (!v.trim() && pending) { const id = pending; setPending(null); void run(op(taskId, "withdraw", { instructionId: id, reason: "cleared before sending" })); }
  };
  const submit = async () => {
    if (!text.trim()) return;
    try { await op(taskId, "submit", { text: text.trim(), ...(pending ? { instructionId: pending } : {}) }); setText(""); setPending(null); } catch (e) { report(e); }
  };
  const pauseOrResume = mode === "running"
    ? <Btn kind="plain" icon={Icon.pause} label="Pause" disabled={stopped} onClick={() => void run(op(taskId, "pause", { reason: "paused from Handoff" }))} />
    : <Btn kind="plain" icon={Icon.play} label="Resume" disabled={stopped} onClick={() => void run(op(taskId, "resume", {}))} />;
  const interrupt = <Btn kind="plain" icon={Icon.bolt} label="Interrupt" title="Interrupt: cancel the agent's current model step now (a running tool finishes)" disabled={stopped || mode === "interrupted"} onClick={() => void run(op(taskId, "interrupt", { reason: "interrupted from Handoff" }))} />;
  const stop = <Btn kind="danger" icon={Icon.stop} label="Stop" title={canStop ? "Stop: end the agent's work and cancel this delegation" : "Only the person who delegated this work can stop it"} disabled={stopped || !canStop} onClick={() => { if (confirm("Stop the agent and cancel this delegation? Work already pushed stays on the branch.")) void run(onStop()); }} />;
  const hint = pending
    ? "The agent knows an update is coming and keeps working. It takes your update at its next checkpoint."
    : mode === "paused" ? "The agent is paused: it starts nothing new. It takes your update at its next checkpoint, after you resume."
    : mode === "interrupted" ? "Interrupted: the current model step was cancelled. Resume to let the agent continue."
    : "The agent keeps working. It takes your update at its next checkpoint.";

  return (
    <div className="agent-control">
      <div className="ctl-bar" aria-label={`Agent ${phase}`}>
        <Btn kind="primary" icon={Icon.pencil} label="Update coming" showLabel disabled={stopped} onClick={() => { ref.current?.focus(); }} />
        {pauseOrResume}{interrupt}{stop}
        <span className={`phase ${phase}`}>{phase}{control?.reason ? ` · ${control.reason}` : ""}</span>
      </div>
      <label className="composer-label" htmlFor={`update-${taskId}`}>Update</label>
      <div className={`composer${stopped ? " disabled" : ""}`}>
        <textarea id={`update-${taskId}`} ref={ref} rows={3} value={text} placeholder="Tell the agent what changed" disabled={stopped}
          onChange={(e) => change(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
        <div className="composer-row">
          <span className={`signal-mark${pending ? " on" : ""}`} title={pending ? "Update coming: the agent knows" : "Start typing to tell the agent an update is coming"}><Svg d={Icon.pencil} /></span>
          <div className="composer-actions">{pauseOrResume}{interrupt}{stop}<Btn kind="primary" icon={Icon.up} label="Send update" disabled={stopped || !text.trim()} onClick={() => void submit()} /></div>
        </div>
      </div>
      <p className="hint">{error ?? hint}</p>
      {control && control.instructions.length > 0 && (
        <ul className="rows instructions">
          {control.instructions.map((i) => (
            <li key={i.instructionId}><span className={`badge ${i.state}`}>{i.state}</span><span>{i.text ?? "(being written)"}</span><span className="muted">{i.from}{i.resolution ? ` · agent: ${i.resolution.note}` : ""}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
