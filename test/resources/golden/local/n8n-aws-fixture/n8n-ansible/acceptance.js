// Authenticated acceptance probes, run INSIDE the n8n container.
//
// It lives here rather than in the smoke shell script because the n8n image
// ships BusyBox wget, which has no --save-cookies/--load-cookies: once the
// owner account is claimed the REST API needs a session, and BusyBox cannot
// hold one. The image is Node 24, so global fetch is available and cookie
// handling is four lines.
const PORT = process.env.N8N_PORT || "5678";
const BASE = `http://127.0.0.1:${PORT}/rest`;
let cookie = "";

const call = async (path, method = "GET", body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

const login = async () => {
  const r = await call("/login", "POST", {
    emailOrLdapLoginId: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PW,
  });
  if (r.status !== 200 || !cookie) throw new Error(`login ${r.status}: ${r.text.slice(0, 200)}`);
};

const CODE = (tag) => ({
  name: tag,
  settings: { executionOrder: "v1" },
  nodes: [
    { parameters: {}, id: "t", name: "Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
    // A Code node is the only thing that proves the EXTERNAL task runner is
    // actually executing work. n8n reports a runner as connected long before
    // it has ever run a task, so a registration check proves nothing.
    { parameters: { jsCode: "return [{json:{acceptance:'ok'}}];" }, id: "c", name: "Code", type: "n8n-nodes-base.code", typeVersion: 2, position: [300, 0] },
  ],
  connections: { Trigger: { main: [[{ node: "Code", type: "main", index: 0 }]] } },
});

const cmd = process.argv[2];
await login();

if (cmd === "create") {
  // A3: create through the API so the row can be read back out of Neon.
  const tag = process.argv[3];
  const r = await call("/workflows", "POST", CODE(tag));
  if (r.status >= 300 || !r.json?.data?.id) throw new Error(`create ${r.status}: ${r.text.slice(0, 200)}`);
  console.log(r.json.data.id);
} else if (cmd === "run-code") {
  // B6: execute a Code node end to end. This is the real runner gate.
  //
  // A bare POST is rejected with
  //   400 "To run the workflow manually, specify either a trigger to start
  //        from or a destination node."
  // `startNodes` is also refused, and `destinationNode` expects an object.
  // The accepted shape is triggerToStartFrom with the node NAME.
  const id = process.argv[3];
  const r = await call(`/workflows/${id}/run`, "POST", {
    triggerToStartFrom: { name: "Trigger" },
  });
  if (r.status >= 300) throw new Error(`run ${r.status}: ${r.text.slice(0, 200)}`);
  const execId = r.json?.data?.executionId;
  if (!execId) throw new Error(`no executionId: ${r.text.slice(0, 200)}`);

  // A 200 from /run only means the execution was ACCEPTED. The runner failing
  // every task -- the exact symptom of a runner/main version mismatch -- also
  // returns 200 here, so the gate has to wait for the terminal status.
  for (let i = 0; i < 30; i++) {
    const e = await call(`/executions/${execId}`);
    const st = e.json?.data?.status;
    if (st && st !== "running" && st !== "new" && st !== "waiting") {
      console.log(String(st));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("timeout");
} else if (cmd === "delete") {
  // Archive before delete: n8n 2.x rejects deleting a live workflow with
  // "Workflow must be archived before it can be deleted."
  const id = process.argv[3];
  await call(`/workflows/${id}/archive`, "POST", {});
  await call(`/workflows/${id}`, "DELETE");
  console.log("deleted");
} else {
  throw new Error(`unknown command ${cmd}`);
}
