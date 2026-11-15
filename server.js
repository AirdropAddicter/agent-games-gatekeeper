// Proof Gatekeeper agent — HTTP endpoint (Node.js, no framework).
//
// Flow per task (platform deadline: 60s; our measured path is ~1s):
//   1. Read raw body. Verify HMAC (x-agent-games-signature) BEFORE parsing.
//      Bad/missing signature => 401, no further work.
//   2. Parse JSON. task_id replay => return the cached response byte-identical.
//   3. Decide with the deterministic 7-trap checklist (decide.js).
//   4. Best-effort on-chain check (currently a documented no-op — onchain.js).
//   5. Generate a Groth16 proof of the decision (circuit.js) — skipped for
//      PROOF_REUSED (no proof to submit) and INVALID_TASK (unbuildable
//      inputs). On proof failure the decision is still returned WITHOUT a
//      proof: a correct decision without proof scores +12-2, while flipping
//      the decision would score -3 (and still have no proof). The failure
//      is logged loudly — it means the code and the circuit disagree.
//   6. Sign the response with HMAC over the raw response body and return it.
//   7. Atomically record (proof_tx seen + response cached) for
//      competition-mode tasks.
//
// Tasks are handled strictly one at a time (FIFO queue): tasks are rare
// (8 per round over ~10h), and serializing removes all seen-set races and
// snarkjs CPU contention.
const http = require("http");
const crypto = require("crypto");
const { config } = require("./config");
const { decide } = require("./decide");
const { proveDecision } = require("./circuit");
const store = require("./store");
const { checkProofOnChain } = require("./onchain");

const MAX_BODY_BYTES = 1024 * 1024;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// --- HMAC helpers -------------------------------------------------------
function hmacHex(secretKey, bodyBuffer) {
  return crypto.createHmac("sha256", secretKey).update(bodyBuffer).digest("hex");
}

function candidateKeys(secret) {
  const keys = [Buffer.from(secret, "utf8")];
  if (/^[0-9a-fA-F]{64}$/.test(secret)) keys.push(Buffer.from(secret, "hex"));
  return keys;
}

function decodeSignature(value) {
  let v = String(value).trim();
  if (v.toLowerCase().startsWith("sha256=")) v = v.slice(7);
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  // Fall back to base64.
  try {
    const b = Buffer.from(v, "base64");
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return null;
}

// The platform's exact key form (raw string vs hex-decoded bytes) is not
// documented; accept either on verify. Responses are signed with the raw
// string form (the most common convention).
function verifySignature(rawBody, signatureHeader) {
  if (!config.hmacSecret) return false;
  if (!signatureHeader) return false;
  const sig = decodeSignature(signatureHeader);
  if (!sig || sig.length !== 32) return false;
  for (const key of candidateKeys(config.hmacSecret)) {
    const expected = crypto.createHmac("sha256", key).update(rawBody).digest();
    if (crypto.timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

function signResponse(bodyString) {
  return hmacHex(Buffer.from(config.hmacSecret, "utf8"), Buffer.from(bodyString, "utf8"));
}

// --- Task handling ------------------------------------------------------
async function handleTaskEnvelope(envelope) {
  const taskId = envelope.task_id || null;
  const mode = envelope.mode || "competition";
  const input = envelope.input || null;

  // No input payload (e.g. a preflight ping): acknowledge.
  if (!input) {
    return { status: "ok", task_id: taskId };
  }

  const { decision, reason_code } = decide(input, (tx) => store.hasSeenProofTx(tx));

  // Best-effort on-chain check (no-op unless configured — see onchain.js).
  // It never changes the decision today: the field checks decide.
  const onchain = await checkProofOnChain(input.proof_tx);
  if (onchain.checked && onchain.onChain === false) {
    log(`[task ${taskId}] WARNING: on-chain check says proof NOT on-chain; field checks still decide`);
  }

  const response = {
    decision,
    reason_code,
    proof_tx: input.proof_tx,
  };

  // PROOF_REUSED tasks have no proof to submit (platform excludes them
  // from the proof bonus); INVALID_TASK has unbuildable circuit inputs.
  const skipProof = reason_code === "PROOF_REUSED" || reason_code === "INVALID_TASK";
  let proveMs = null;
  if (!skipProof) {
    try {
      const { proof, publicSignals, proveMs: ms } = await proveDecision(
        input,
        decision === "APPROVE" ? 1 : 0,
        taskId || ""
      );
      proveMs = ms;
      // Field names follow the platform's own convention from the
      // Steal-the-VFY protocol ("the Groth16 proof and public_signals").
      // The Gatekeeper response sample on the event page omits the proof
      // fields entirely — confirm against practice mode (see README).
      response.proof = proof;
      response.public_signals = publicSignals;
    } catch (e) {
      log(`[task ${taskId}] PROOF FAILED for ${decision}/${reason_code}: ${e.message} — returning decision without proof`);
    }
  }

  const body = JSON.stringify(response);
  store.recordTask({ taskId, proofTx: input.proof_tx, responseBody: body, mode });
  log(
    `[task ${taskId}] mode=${mode} decision=${decision} reason=${reason_code} ` +
      `proof=${skipProof ? "skipped" : response.proof ? `ok (${proveMs} ms)` : "FAILED"}`
  );
  return { body };
}

// --- HTTP server --------------------------------------------------------
function createServer() {
  // Serialize task handling (FIFO).
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === "/health" || url.pathname === "/" || url.pathname === "/healthz") {
        const body = JSON.stringify({
          status: "ok",
          service: "proof-gatekeeper",
          ...store.stats(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "GET") res.end(body);
        else res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      enqueue(async () => {
        const rawBody = Buffer.concat(chunks);
        try {
          if (!config.hmacSecret) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "agent_not_configured" }));
            return;
          }
          if (!verifySignature(rawBody, req.headers["x-agent-games-signature"])) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_signature" }));
            return;
          }
          let envelope;
          try {
            envelope = JSON.parse(rawBody.toString("utf8"));
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad_json" }));
            return;
          }
          // Idempotency: retried task_id => byte-identical cached response.
          if (envelope.task_id) {
            const cached = store.getCachedResponse(envelope.task_id);
            if (cached) {
              res.writeHead(200, {
                "content-type": "application/json",
                "x-agent-games-signature": signResponse(cached),
              });
              res.end(cached);
              log(`[task ${envelope.task_id}] replay => cached response`);
              return;
            }
          }
          const result = await handleTaskEnvelope(envelope);
          const body = result.body || JSON.stringify(result);
          res.writeHead(200, {
            "content-type": "application/json",
            "x-agent-games-signature": signResponse(body),
          });
          res.end(body);
        } catch (e) {
          // Fail closed on unexpected errors: never leave the platform
          // hanging (a timeout is -2; a 500 with no body is worse).
          log(`[error] ${e.stack || e.message}`);
          if (!res.headersSent) {
            const body = JSON.stringify({
              decision: "REJECT",
              reason_code: "INVALID_TASK",
            });
            res.writeHead(200, {
              "content-type": "application/json",
              "x-agent-games-signature": signResponse(body),
            });
            res.end(body);
          }
        }
      });
    });
  });

  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    log(`Proof Gatekeeper agent listening on http://${config.host}:${config.port}`);
    if (!config.hmacSecret) {
      log("HMAC secret MISSING (all requests will 503)");
    } else if (config.hmacSecretIsPlaceholder) {
      log("HMAC secret is the PLACEHOLDER — replace it in .env after agent registration, then ./supervise.sh restart");
    } else {
      log("HMAC secret configured");
    }
    log(`State: ${JSON.stringify(store.stats())}`);
  });
}

module.exports = { createServer, verifySignature, signResponse, handleTaskEnvelope };
