// Minimal MCP (JSON-RPC over HTTP) client for Handoff's capabilities, with the runner pool's session.
export function handoff(url, token) {
  let id = 0; let names = null;
  async function rpc(method, params = {}) {
    const res = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (res.status === 401) throw Object.assign(new Error("session refused (revoked or expired)"), { code: "UNAUTHORIZED" });
    return res.json();
  }
  /** Call a capability; throws { code, message } on refusal. */
  async function call(capability, args = {}) {
    if (!names) {
      await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "handoff-runner", version: "0.1.0" } });
      const list = await rpc("tools/list");
      names = new Map((list.result?.tools ?? []).map((t) => [t.name.replace(/_/g, "."), t.name]));
    }
    const r = await rpc("tools/call", { name: names.get(capability) ?? capability, arguments: args });
    if (r.error) throw Object.assign(new Error(r.error.message), { code: `RPC_${r.error.code}` });
    const text = r.result?.content?.[0]?.text ?? "";
    if (r.result?.isError) {
      const meta = r.result?._meta?.["dev.appport/error"];
      throw Object.assign(new Error(text), { code: meta?.details?.reason ?? meta?.code ?? text.match(/^([A-Z_.]+):/)?.[1] ?? "ERROR" });
    }
    const sc = r.result?.structuredContent;
    let value = sc && typeof sc === "object" && "result" in sc ? sc.result : sc ?? text;
    if (typeof value === "string") { try { value = JSON.parse(value); } catch {} }
    return value;
  }
  return { call };
}
