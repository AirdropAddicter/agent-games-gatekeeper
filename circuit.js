// Groth16 proof generation for the official gatekeeper circuit.
//
// Circuit facts (verified locally 2026-11-15 with snarkjs 0.7.6 against
// gatekeeper.wasm / gatekeeper_final.zkey):
// - 13 input signals, ALL public (vk nPublic = 13). Public-signal order:
//   [0] salt, [1] registeredVkHash, [2] proofVkHash, [3] minimum,
//   [4] publicBalance, [5] expiryBlock, [6] currentBlock, [7] recipient,
//   [8] conditionRecipient, [9] amount, [10] maxTransfer, [11] decision,
//   [12] taskId.
// - The circuit enforces decision == 1 IF AND ONLY IF every check passes.
//   A wrong decision cannot even build a witness (fullProve throws
//   "Assert Failed ... GatekeeperEvaluation line 102").
// - Measured fullProve: ~0.9s first run (wasm load), ~0.2-0.3s after that.
//   Proof JSON is ~720-730 bytes. Far inside the 60s deadline.
//
// ENCODING (assumptions — the platform's exact mapping is NOT publicly
// documented; see README "Known gaps". These are the most natural mappings
// and are validated end-to-end locally with snarkjs verify):
// - 32-byte hashes (registeredVkHash, proofVkHash): BigInt(hex) mod p.
// - Addresses (20 bytes): BigInt(hex). Numbers: BigInt(decimal).
// - taskId (string, e.g. "gk_24_9d1"): UTF-8 bytes as a big integer
//   (configurable via TASK_ID_ENCODING; see config.js).
// - salt: random 31-byte value mod p, fresh per proof. It is a public
//   signal, so it hides nothing; it only makes each proof's public
//   signals unique per task attempt.
// If practice mode rejects proofs, the encoding is the first suspect.
const snarkjs = require("snarkjs");
const crypto = require("crypto");
const fs = require("fs");
const { config } = require("./config");

// BN254 (bn128) scalar field prime.
const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let vkCache = null;
function loadVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(config.vkPath, "utf8"));
  return vkCache;
}

function toFieldHex(hex) {
  const h = String(hex).toLowerCase().startsWith("0x") ? hex : "0x" + hex;
  return (BigInt(h) % FIELD_P).toString();
}

function toFieldDec(v) {
  return (BigInt(v) % FIELD_P).toString();
}

function taskIdToField(taskId) {
  const enc = config.taskIdEncoding;
  if (enc === "utf8") {
    return BigInt("0x" + Buffer.from(String(taskId), "utf8").toString("hex")).toString();
  }
  if (enc === "fnv1a") {
    // 64-bit FNV-1a over UTF-8 bytes.
    let h = 14695981039346656037n;
    const prime = 1099511628211n;
    for (const b of Buffer.from(String(taskId), "utf8")) {
      h ^= BigInt(b);
      h = (h * prime) % (1n << 64n);
    }
    return h.toString();
  }
  if (enc === "keccak") {
    // keccak256 needs an implementation; use Node's sha3-256 only as a
    // clearly-marked stand-in is WRONG (different hash), so refuse.
    throw new Error(
      "TASK_ID_ENCODING=keccak requires a keccak256 implementation (not bundled). " +
        "Install js-sha3 and wire it here."
    );
  }
  throw new Error(`Unknown TASK_ID_ENCODING: ${enc}`);
}

function randomSalt() {
  return (BigInt("0x" + crypto.randomBytes(31).toString("hex")) % FIELD_P).toString();
}

// Build the circuit input object from a task's input fields + decision.
// decision: 1 = APPROVE, 0 = REJECT.
function buildCircuitInput(input, decision, taskId) {
  return {
    registeredVkHash: toFieldHex(input.registered_vk),
    proofVkHash: toFieldHex(input.proof_vk),
    minimum: toFieldDec(input.minimum),
    publicBalance: toFieldDec(input.public_balance),
    expiryBlock: toFieldDec(input.expiry_block),
    currentBlock: toFieldDec(input.current_block),
    recipient: toFieldHex(input.recipient),
    conditionRecipient: toFieldHex(input.condition_recipient),
    amount: toFieldDec(input.amount),
    maxTransfer: toFieldDec(input.max_transfer),
    decision: decision ? "1" : "0",
    taskId: taskIdToField(taskId),
    salt: randomSalt(),
  };
}

// Generate a Groth16 proof for a decision. Returns { proof, publicSignals,
// proveMs }. Throws on witness/proving failure (caller fails closed).
async function proveDecision(input, decision, taskId, opts = {}) {
  const timeoutMs = opts.timeoutMs || config.proveTimeoutMs;
  const circuitInput = buildCircuitInput(input, decision, taskId);
  const t0 = Date.now();
  const { proof, publicSignals } = await withTimeout(
    snarkjs.groth16.fullProve(circuitInput, config.wasmPath, config.zkeyPath),
    timeoutMs,
    "proof generation timed out"
  );
  const proveMs = Date.now() - t0;
  // Self-check: verify our own proof before sending it. Cheap (~ms) and
  // catches any local proving corruption before the platform sees it.
  const ok = await snarkjs.groth16.verify(loadVk(), publicSignals, proof);
  if (!ok) throw new Error("local proof self-verification failed");
  return { proof, publicSignals, proveMs, circuitInput };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = {
  FIELD_P,
  proveDecision,
  buildCircuitInput,
  taskIdToField,
  toFieldHex,
  toFieldDec,
  loadVk,
};
