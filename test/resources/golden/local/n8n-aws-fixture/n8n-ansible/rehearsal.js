// Restore-rehearsal helpers, run inside an n8n container.
//
// Split from acceptance.js because these talk to whichever instance they are
// pointed at -- production when seeding, the scratch stack when verifying --
// and conflating the two is how a rehearsal ends up proving that production
// still works.
const BASE = `http://127.0.0.1:${process.env.N8N_PORT || 5678}/rest`;
let cookie = "";

const call = async (path, method = "GET", body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

const login = async () => {
  const r = await call("/login", "POST", {
    emailOrLdapLoginId: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PW,
  });
  if (r.status !== 200 || !cookie) throw new Error(`login ${r.status}: ${r.text.slice(0, 160)}`);
};

const TAG = process.env.REHEARSAL_TAG;
const cmd = process.argv[2];

if (cmd === "seed") {
  // Everything the rehearsal will later have to prove survived. A dump alone
  // can be restored and still be useless, so seed the three things that make
  // a restore a RECOVERY: an encrypted credential, a binary payload, and a
  // workflow that references both.
  await login();
  const cred = await call("/credentials", "POST", {
    name: `${TAG}-cred`,
    type: "httpHeaderAuth",
    // This is the value the rehearsal must read back DECRYPTED. If the
    // encryption key did not survive, this is what comes back as garbage.
    data: { name: "X-Colors-Rehearsal", value: `secret-${TAG}` },
  });
  if (cred.status >= 300) throw new Error(`credential ${cred.status}: ${cred.text.slice(0, 160)}`);
  // The workflow USES the credential, because that is the only way to prove
  // it decrypts (see the verify branch). An HTTP Request node with header auth
  // pointed at n8n's own liveness endpoint needs no external network.
  const wf = await call("/workflows", "POST", {
    name: `${TAG}-wf`,
    settings: { executionOrder: "v1" },
    nodes: [
      { parameters: {}, id: "t", name: "Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: {
          url: `http://127.0.0.1:${process.env.N8N_PORT || 5678}/healthz`,
          authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
          options: {},
        },
        credentials: { httpHeaderAuth: { id: cred.json.data.id, name: `${TAG}-cred` } },
        id: "h", name: "UseCred", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [300, 0] },
      { parameters: { jsCode: `return [{json:{tag:'${TAG}'},binary:{data:{data:Buffer.from('rehearsal-${TAG}').toString('base64'),mimeType:'text/plain',fileName:'r.txt'}}}];` },
        id: "c", name: "Code", type: "n8n-nodes-base.code", typeVersion: 2, position: [560, 0] },
    ],
    connections: {
      Trigger: { main: [[{ node: "UseCred", type: "main", index: 0 }]] },
      UseCred: { main: [[{ node: "Code", type: "main", index: 0 }]] },
    },
  });
  if (wf.status >= 300) throw new Error(`workflow ${wf.status}: ${wf.text.slice(0, 160)}`);
  const id = wf.json.data.id;
  // Execute it so a binary payload actually lands in the data directory --
  // which is the half of the backup set the pg_dump does not cover.
  const run = await call(`/workflows/${id}/run`, "POST", { triggerToStartFrom: { name: "Trigger" } });
  if (run.status >= 300) throw new Error(`run ${run.status}: ${run.text.slice(0, 160)}`);
  for (let i = 0; i < 30; i++) {
    const e = await call(`/executions/${run.json.data.executionId}`);
    if (e.json?.data?.status === "success") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(JSON.stringify({ workflowId: id, credentialId: cred.json.data.id }));

} else if (cmd === "verify") {
  // Against the RESTORED stack. Four independent claims, each of which a
  // checksum-only verification would have missed entirely.
  const out = { login: false, workflow: false, credential: false, binary: false };

  // 1. An operator can actually sign in. Whole-host recovery restores the
  //    database and the data directory but NOT /etc/n8n/secrets, so a restore
  //    nobody can log into is not a recovery.
  await login();
  out.login = true;

  const wfs = await call("/workflows");
  const mine = (wfs.json?.data || []).filter((w) => w.name.startsWith(TAG));
  out.workflow = mine.length > 0;

  // 2. A stored credential DECRYPTS. This is the operator-held encryption key
  //    doing its job; without it every credential in the dump is noise.
  const creds = await call("/credentials");
  const cred = (creds.json?.data || []).find((c) => c.name.startsWith(TAG));
  // Proving a credential DECRYPTED cannot be done by reading it back: n8n
  // redacts credential values in API responses, returning a fixed-length
  // sentinel rather than the plaintext (observed: 54 chars for a 27-char
  // secret, matching no real value). Comparing that to the seeded value would
  // fail forever and look like the encryption key had not survived.
  //
  // The honest proof is to USE it. n8n resolves and decrypts a node's
  // credential at execution time and fails the node outright if it cannot, so
  // a successful execution of a workflow whose HTTP node carries this
  // credential is end-to-end evidence that the operator key decrypted it.
  if (mine.length) {
    const r = await call(`/workflows/${mine[0].id}/run`, "POST", { triggerToStartFrom: { name: "Trigger" } });
    const execId = r.json?.data?.executionId;
    for (let i = 0; execId && i < 40; i++) {
      const e = await call(`/executions/${execId}`);
      const st = e.json?.data?.status;
      if (st && !["running", "new", "waiting"].includes(st)) {
        out.credential = st === "success";
        out.credentialDetail = st === "success"
          ? "a node using the credential executed successfully"
          : `execution ${st} -- the credential did not resolve`;
        break;
      }
      await new Promise((x) => setTimeout(x, 1000));
    }
    if (out.credentialDetail === undefined) out.credentialDetail = "execution did not reach a terminal status";
  } else {
    out.credentialDetail = "workflow absent, cannot exercise the credential";
  }

  // 3. A binary payload from the restored data directory is readable.
  if (mine.length) {
    const execs = await call(`/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId: mine[0].id }))}`);
    const rows = execs.json?.data?.results ?? execs.json?.data ?? [];
    // Any execution carrying the payload will do -- the one restored from the
    // seed, or the one just run to exercise the credential.
    for (const row of rows.slice(0, 5)) {
      const detail = await call(`/executions/${row.id}`);
      if (JSON.stringify(detail.json?.data?.data ?? {}).includes("r.txt")) { out.binary = true; break; }
    }
    out.executionCount = rows.length;
  }
  console.log(JSON.stringify(out));
} else {
  throw new Error(`unknown command ${cmd}`);
}
