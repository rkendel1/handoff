// A local stand-in for the parts of GitHub's REST API Handoff uses. Used by automated tests and the
// live recovery scenario: real GitHub writes are not authorized in this build (no external changes).
//
// Branch heads come from an in-memory map or, with `bareRepo`, from a real bare git repository the
// runner pushes to. Fault modes reproduce what the product must survive:
//   dropAfterCreate  the next PR create is applied, then the connection is destroyed (unknown outcome)
//   status:<code>    every request answers that status (429 rate limit, 503 outage) until cleared
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

export async function startGitHubStub({ port = 0, bareRepo = null, token = null } = {}) {
  const branches = new Map();
  const pulls = [];
  const issues = new Map();
  const files = new Map(); // head sha -> [{ filename, status, additions, deletions, patch }]
  const reviews = new Map(); // pr number -> [{ state, user: { login }, submitted_at }]
  const counts = { pullsCreated: 0, createRequests: 0, requests: 0, rejectedAuth: 0 };
  const log = [];
  let dropNextCreate = false;
  let dropBeforeCreate = false;
  let forcedStatus = null;
  let checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];

  const head = (b) => {
    if (bareRepo) {
      try { return execFileSync("git", ["--git-dir", bareRepo, "rev-parse", `refs/heads/${b}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
    }
    return branches.get(b) ?? null;
  };
  const pullView = (p) => ({ number: p.number, state: p.state, merged: p.merged, html_url: `https://github.test/${p.owner}/${p.repo}/pull/${p.number}`, head: { ref: p.head, sha: head(p.head) ?? p.sha }, base: { ref: p.base } });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      counts.requests++;
      const url = new URL(req.url, "http://stub");
      log.push({ method: req.method, path: url.pathname, query: url.search, idempotencyKey: req.headers["idempotency-key"] ?? null, auth: req.headers.authorization ? "present" : "absent" });
      const send = (status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      if (token && req.headers.authorization !== `Bearer ${token}` && req.headers.authorization !== `token ${token}`) { counts.rejectedAuth++; return send(401, { message: "Bad credentials" }); }
      if (forcedStatus) return send(forcedStatus, { message: forcedStatus === 429 ? "API rate limit exceeded" : "Service unavailable" }, forcedStatus === 429 ? { "x-ratelimit-remaining": "0", "retry-after": "60" } : {});
      const root = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/?$/);
      if (root) return send(200, { full_name: `${root[1]}/${root[2]}`, default_branch: "main", private: true });
      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!m) return send(404, { message: "Not Found" });
      const [, owner, repo, rest] = m;
      if (rest === "pulls" && req.method === "GET") {
        const want = url.searchParams.get("head"); const state = url.searchParams.get("state") ?? "open";
        const list = pulls.filter((p) => p.owner === owner && p.repo === repo && (!want || `${owner}:${p.head}` === want) && (state === "all" || p.state === state));
        return send(200, list.map(pullView));
      }
      if (rest === "pulls" && req.method === "POST") {
        counts.createRequests++;
        if (dropBeforeCreate) { dropBeforeCreate = false; req.socket.destroy(); return; }
        const b = JSON.parse(body || "{}");
        const sha = head(b.head);
        if (!sha) return send(422, { message: "Validation Failed: head branch does not exist" });
        if (pulls.some((p) => p.owner === owner && p.repo === repo && p.head === b.head && p.state === "open")) return send(422, { message: `A pull request already exists for ${owner}:${b.head}.` });
        const p = { owner, repo, number: pulls.length + 1, state: "open", merged: false, head: b.head, base: b.base, title: b.title, sha };
        pulls.push(p); counts.pullsCreated++;
        if (dropNextCreate) { dropNextCreate = false; req.socket.destroy(); return; }
        return send(201, pullView(p));
      }
      let mm;
      if ((mm = rest.match(/^pulls\/(\d+)$/)) && req.method === "GET") {
        const p = pulls.find((x) => x.owner === owner && x.repo === repo && x.number === Number(mm[1]));
        return p ? send(200, pullView(p)) : send(404, { message: "Not Found" });
      }
      if ((mm = rest.match(/^branches\/(.+)$/))) {
        const sha = head(decodeURIComponent(mm[1]));
        return sha ? send(200, { name: decodeURIComponent(mm[1]), commit: { sha } }) : send(404, { message: "Branch not found" });
      }
      if ((mm = rest.match(/^compare\/(.+)\.\.\.(.+)$/))) {
        const [b, hd] = [decodeURIComponent(mm[1]), decodeURIComponent(mm[2])];
        if (bareRepo) {
          const g = (...a) => execFileSync("git", ["--git-dir", bareRepo, ...a], { encoding: "utf8" });
          const commits = g("log", "--format=%H%x09%s", `${b}..${hd}`).trim().split("\n").filter(Boolean).map((l) => { const [sha, ...m] = l.split("\t"); return { sha, commit: { message: m.join("\t") } }; });
          const fileList = g("diff", "--numstat", `${b}`, `${hd}`).trim().split("\n").filter(Boolean).map((l) => { const [add, del, name] = l.split("\t"); return { filename: name, status: "modified", additions: Number(add), deletions: Number(del), patch: g("diff", `${b}`, `${hd}`, "--", name).split("\n").slice(4).join("\n") }; });
          return send(200, { status: "ahead", ahead_by: commits.length, total_commits: commits.length, commits, files: fileList });
        }
        const fl = files.get(hd) ?? [];
        return send(200, { status: "ahead", ahead_by: 1, total_commits: 1, commits: [{ sha: hd, commit: { message: "Delegated change" } }], files: fl });
      }
      if ((mm = rest.match(/^pulls\/(\d+)\/reviews$/))) return send(200, reviews.get(Number(mm[1])) ?? []);
      if (rest === "" || rest === undefined) return send(200, { full_name: `${owner}/${repo}`, default_branch: "main", private: true });
      if ((mm = rest.match(/^commits\/([^/]+)\/check-runs$/))) return send(200, { total_count: checkRuns.length, check_runs: checkRuns });
      if ((mm = rest.match(/^issues\/(\d+)$/))) {
        const i = issues.get(Number(mm[1]));
        return i ? send(200, { number: Number(mm[1]), state: "open", ...i }) : send(404, { message: "Not Found" });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, counts, log, pulls,
    setBranch: (b, sha) => branches.set(b, sha),
    setIssue: (n, issue) => issues.set(n, issue),
    setFiles: (sha, list) => files.set(sha, list),
    setReviews: (n, list) => reviews.set(n, list),
    setChecks: (list) => { checkRuns = list; },
    dropNextCreate: () => { dropNextCreate = true; },
    dropBeforeCreate: () => { dropBeforeCreate = true; },
    setStatus: (code) => { forcedStatus = code; },
    mergePull: (n) => { const p = pulls.find((x) => x.number === n); if (p) { p.state = "closed"; p.merged = true; } },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
