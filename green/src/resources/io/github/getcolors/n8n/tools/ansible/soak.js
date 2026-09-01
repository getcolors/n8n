// The soak workload. Called by n8n-soak.sh inside the n8n container.
//
// A bare count of trivial executions would satisfy every threshold without
// touching what actually breaks this host, so the mix is explicit: an API tier
// (the ordinary case), a Code-node tier sized to trigger the payload
// duplication, and a binary tier that forces writes through the filesystem
// binary-data path and therefore through pruning and WAL.
const TAG = process.env.SOAK_TAG;
const N = parseInt(process.env.SOAK_N, 10);
const SECS = parseInt(process.env.SOAK_SECS, 10);
const MIX = { api: +process.env.SOAK_API, code: +process.env.SOAK_CODE, bin: +process.env.SOAK_BIN };
const CODE_MB = +process.env.SOAK_CODE_MB, BIN_MB = +process.env.SOAK_BIN_MB;
const BASE = `http://127.0.0.1:${process.env.N8N_PORT || 5678}/rest`;

// Authenticated, like every other probe: once the owner account is claimed the
// REST API needs a session. The image's BusyBox wget cannot hold a cookie, so
// this is Node and carries one itself.
let cookie = "";
const api = async (path, method = "GET", body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return r.json();
};
const login = async () => {
  await api("/login", "POST", {
    emailOrLdapLoginId: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PW,
  });
  if (!cookie) throw new Error("login produced no session cookie");
};

// A Code node duplicates its input before processing and again after, so a
// payload of CODE_MB transiently costs roughly 3x that. This is the tier the
// concurrency bound has to be sized against.
const codeNode = (mb) => ({
  parameters: { jsCode: `const s='x'.repeat(${mb}*1024*1024); return [{json:{n:s.length}}];` },
  id: "code", name: "Code", type: "n8n-nodes-base.code", typeVersion: 2, position: [420, 0],
});
const binNode = (mb) => ({
  parameters: { jsCode: `return [{json:{},binary:{data:{data:Buffer.alloc(${mb}*1024*1024).toString('base64'),mimeType:'application/octet-stream',fileName:'soak.bin'}}}];` },
  id: "bin", name: "Binary", type: "n8n-nodes-base.code", typeVersion: 2, position: [420, 0],
});
const trigger = { parameters: {}, id: "t", name: "When clicking", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] };
const SETTINGS = { executionOrder: "v1" };
const wf = (name, extra) => ({
  name, settings: SETTINGS,
  nodes: extra ? [trigger, extra] : [trigger],
  connections: extra ? { "When clicking": { main: [[{ node: extra.name, type: "main", index: 0 }]] } } : {},
});

await login();

if (process.argv[2] === "--cleanup") {
  const tag = process.argv[3];
  const all = await api("/workflows");
  const mine = (all.data || []).filter((w) => w.name.startsWith(tag));
  // n8n 2.x refuses to delete a live workflow:
  //   400 {"code":400,"message":"Workflow must be archived before it can be
  //        deleted."}
  // Archive first, then delete. A DELETE-only cleanup silently leaves every
  // workflow behind, and the soak's own residue then poisons the next run's
  // measurements and every backup taken afterwards.
  for (const w of mine) {
    await api(`/workflows/${w.id}/archive`, "POST", {}).catch(() => {});
    await api(`/workflows/${w.id}`, "DELETE").catch(() => {});
  }
  console.log(`cleaned ${mine.length} workflows`);
  process.exit(0);
}

const made = [];
for (let i = 0; i < N; i++) {
  const r = Math.random() * 100;
  const node = r < MIX.api ? null : r < MIX.api + MIX.code ? codeNode(CODE_MB) : binNode(BIN_MB);
  const w = await api("/workflows", "POST", wf(`${TAG}-${i}`, node));
  made.push(w.data.id);
}

const deadline = Date.now() + SECS * 1000;
let done = 0, failed = 0;
while (Date.now() < deadline) {
  await Promise.all(made.map(async (id) => {
    // An empty body is refused with "specify either a trigger to start from
    // or a destination node"; the accepted shape names the trigger NODE.
    try {
      await api(`/workflows/${id}/run`, "POST", { triggerToStartFrom: { name: "When clicking" } });
      done++;
    } catch { failed++; }
  }));
}
console.log(`soak: ${done} executions, ${failed} failed, ${made.length} workflows`);
