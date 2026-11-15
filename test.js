// End-to-end test suite for the Proof Gatekeeper agent.
// Starts the server on an ephemeral port with a TEST HMAC secret and:
//  - health check
//  - HMAC accept/reject (good sig, bad sig, missing sig)
//  - all 7 trap varieties (decision + reason_code assertions)
//  - local snarkjs verification of every attached proof
//  - PROOF_REUSED via a repeated proof_tx (no proof attached)
//  - task replay returns the byte-identical cached response
//  - response-signature verification
//  - proof-generation timing (must fit the 60s platform deadline)
// Usage: node test.js   (exit 0 = all pass)
process.env.AGENT_GAMES_HMAC_SECRET = "test-secret-for-local-tests-only-0123456789";
process.env.PORT = "0"; // ephemeral (we listen on port 0 explicitly below)
process.env.STATE_PATH = require("path").join(__dirname, "data", "state.test.json");

const http = require("http");
const crypto = require("crypto");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

const { createServer } = require("./server");
const { loadVk } = require("./circuit");
const store = require("./store");

const SECRET = process.env.AGENT_GAMES_HMAC_SECRET;
const VK = loadVk();
const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const OTHER_VK = "0xa4c1b8ff00000000000000000000000000000000000000000000000000000000";
const ADDR_A = "0xDe42a7e8b3c14d25f6a09e8c7b2d1f0a9e8c7b6a";
const ADDR_B = "0x1111111111111111111111111111111111111111";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

function baseInput(over = {}) {
  return {
    registered_vk: VK_HASH,
    proof_vk: VK_HASH,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: ADDR_A,
    condition_recipient: ADDR_A,
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...over,
  };
}

function task(id, input, mode = "competition") {
  return { type: "agent-games.proof-gatekeeper.v1", task_id: id, mode, input };
}

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function request(port, method, pathName, body, signature) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathName, method, timeout: 70000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (signature !== undefined) req.setHeader("x-agent-games-signature", signature);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function postTask(port, envelope, sigOverride) {
  const body = JSON.stringify(envelope);
  const sig = sigOverride !== undefined ? sigOverride : sign(body);
  const t0 = Date.now();
  const res = await request(port, "POST", "/", body, sig);
  return { ...res, ms: Date.now() - t0, sentBody: body };
}

async function verifyAttachedProof(resBody, label) {
  const parsed = JSON.parse(resBody);
  if (!parsed.proof || !parsed.public_signals) {
    check(`${label}: proof attached`, false, "missing proof/public_signals");
    return false;
  }
  check(`${label}: 13 public signals`, parsed.public_signals.length === 13, `got ${parsed.public_signals.length}`);
  const ok = await snarkjs.groth16.verify(VK, parsed.public_signals, parsed.proof);
  check(`${label}: attached proof verifies (snarkjs)`, ok === true);
  return ok;
}

function verifyResponseSignature(res) {
  const sig = res.headers["x-agent-games-signature"];
  if (!sig) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(res.body).digest();
  try {
    return crypto.timingSafeEqual(expected, Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

async function main() {
  try { fs.unlinkSync(process.env.STATE_PATH); } catch { /* fresh start */ }
  store._resetForTests();
  // Use a scratch state file so tests never touch production state.
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`test server on 127.0.0.1:${port}\n`);

  // 1. Health check
  const health = await request(port, "GET", "/health");
  check("GET /health -> 200 ok", health.status === 200 && JSON.parse(health.body).status === "ok");

  // 2. HMAC: missing / bad / good
  const noSig = await postTask(port, task("t-nosig", baseInput()), null);
  check("missing signature -> 401", noSig.status === 401);
  const badSig = await postTask(port, task("t-badsig", baseInput()), "00".repeat(32));
  check("bad signature -> 401", badSig.status === 401);
  const wrongKeySig = crypto
    .createHmac("sha256", "wrong-key")
    .update(JSON.stringify(task("t-wrongkey", baseInput())))
    .digest("hex");
  const wrongKey = await postTask(port, task("t-wrongkey", baseInput()), wrongKeySig);
  check("wrong-key signature -> 401", wrongKey.status === 401);

  // 3. The 7 trap varieties (+ timings)
  const proveTimes = [];
  const cases = [
    ["VALID approve", task("t-valid", baseInput()), "APPROVE", "VALID_CONDITION", true],
    ["VK_SUBSTITUTION", task("t-vk", baseInput({ proof_vk: OTHER_VK, proof_tx: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })), "REJECT", "VK_SUBSTITUTION", true],
    ["THRESHOLD_MISMATCH", task("t-thr", baseInput({ public_balance: "900", proof_tx: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" })), "REJECT", "THRESHOLD_MISMATCH", true],
    ["EXPIRED_CONDITION", task("t-exp", baseInput({ current_block: 8430001, proof_tx: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" })), "REJECT", "EXPIRED_CONDITION", true],
    ["RECIPIENT_MISMATCH", task("t-rcp", baseInput({ recipient: ADDR_B, proof_tx: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" })), "REJECT", "RECIPIENT_MISMATCH", true],
    ["AMOUNT_OVERFLOW", task("t-amt", baseInput({ amount: "1500", proof_tx: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" })), "REJECT", "AMOUNT_OVERFLOW", true],
  ];
  for (const [name, env, wantDecision, wantReason, wantProof] of cases) {
    const res = await postTask(port, env);
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* handled below */ }
    check(`${name}: HTTP 200`, res.status === 200, `got ${res.status}: ${res.body.slice(0, 120)}`);
    check(`${name}: decision=${wantDecision}`, parsed && parsed.decision === wantDecision, parsed ? `got ${parsed.decision}` : "unparsable");
    check(`${name}: reason_code=${wantReason}`, parsed && parsed.reason_code === wantReason, parsed ? `got ${parsed.reason_code}` : "unparsable");
    check(`${name}: response signature verifies`, verifyResponseSignature(res));
    check(`${name}: round-trip ${res.ms} ms < 60s`, res.ms < 60000, `${res.ms} ms`);
    proveTimes.push(res.ms);
    if (wantProof) await verifyAttachedProof(res.body, name);
  }

  // 4. PROOF_REUSED: same proof_tx as the valid task, new task_id.
  const reused = await postTask(
    port,
    task("t-reused", baseInput({ proof_tx: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }))
  );
  const reusedParsed = JSON.parse(reused.body);
  check("PROOF_REUSED: decision=REJECT", reusedParsed.decision === "REJECT");
  check("PROOF_REUSED: reason_code=PROOF_REUSED", reusedParsed.reason_code === "PROOF_REUSED");
  check("PROOF_REUSED: no proof attached", !reusedParsed.proof && !reusedParsed.public_signals);

  // 5. Replay: same task_id twice => byte-identical body.
  const first = await postTask(port, task("t-valid-2", baseInput({ proof_tx: "0x1212121212121212121212121212121212121212121212121212121212121212" })));
  const replay2 = await postTask(port, task("t-valid-2", baseInput({ proof_tx: "0x1212121212121212121212121212121212121212121212121212121212121212" })));
  check("replay: byte-identical response", replay2.body === first.body);
  check("replay: signature still verifies", verifyResponseSignature(replay2));
  // Replaying the original valid task also returns its cached response.
  const replayValid = await postTask(port, task("t-valid", baseInput()));
  check("replay (t-valid): decision still APPROVE from cache", JSON.parse(replayValid.body).decision === "APPROVE");

  // 6. Malformed task => fail closed (REJECT/INVALID_TASK, HTTP 200).
  const malformed = await postTask(port, task("t-malformed", { minimum: "1000" }));
  const malParsed = JSON.parse(malformed.body);
  check("malformed task: HTTP 200 + REJECT/INVALID_TASK", malformed.status === 200 && malParsed.decision === "REJECT" && malParsed.reason_code === "INVALID_TASK");

  // 7. Preflight-style ping (no input) => 200 ok.
  const pingBody = JSON.stringify({ type: "agent-games.preflight.v1", task_id: "preflight-1" });
  const ping = await request(port, "POST", "/", pingBody, sign(pingBody));
  check("preflight ping (no input) -> 200 ok", ping.status === 200 && JSON.parse(ping.body).status === "ok");

  const maxMs = Math.max(...proveTimes);
  console.log(`\nSlowest trap round-trip: ${maxMs} ms (deadline 60000 ms)`);
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);

  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
