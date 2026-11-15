// Probe script: determine the gatekeeper circuit's public-signal order and
// verify the input encoding end to end with snarkjs (NOT part of the agent).
// Usage: node probe.js
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const WASM = path.join(__dirname, "circuits", "gatekeeper.wasm");
const ZKEY = path.join(__dirname, "circuits", "gatekeeper_final.zkey");
const VK = JSON.parse(
  fs.readFileSync(path.join(__dirname, "circuits", "verification_key.json"), "utf8")
);

const toField = (hex) => (BigInt(hex) % FIELD_P).toString();
const taskIdToField = (s) =>
  BigInt("0x" + Buffer.from(s, "utf8").toString("hex")).toString();
const randSalt = () =>
  (BigInt("0x" + crypto.randomBytes(31).toString("hex")) % FIELD_P).toString();

const VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42a7e8b3c14d25f6a09e8c7b2d1f0a9e8c7b6a";

function inputs(over = {}) {
  return {
    registeredVkHash: toField(VK_HASH),
    proofVkHash: toField(VK_HASH),
    minimum: "1000",
    publicBalance: "1460",
    expiryBlock: "8430000",
    currentBlock: "8420000",
    recipient: BigInt(ADDR).toString(),
    conditionRecipient: BigInt(ADDR).toString(),
    amount: "500",
    maxTransfer: "1000",
    decision: "1",
    taskId: taskIdToField("gk_24_9d1"),
    salt: randSalt(),
    ...over,
  };
}

async function attempt(name, input) {
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const proveMs = Date.now() - t0;
    const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
    console.log(`\n[${name}] fullProve OK in ${proveMs} ms, verify=${ok}`);
    console.log("publicSignals:", JSON.stringify(publicSignals));
    console.log("proof bytes:", JSON.stringify(proof).length);
    return { ok, publicSignals, proveMs };
  } catch (e) {
    console.log(`\n[${name}] fullProve FAILED in ${Date.now() - t0} ms: ${e.message}`);
    return { ok: false };
  }
}

(async () => {
  console.log("taskId field value for gk_24_9d1:", taskIdToField("gk_24_9d1"));
  console.log("vkHash mod p:", toField(VK_HASH));
  console.log("recipient field value:", BigInt(ADDR).toString());

  const valid = await attempt("VALID approve (all checks pass, decision=1)", inputs());

  if (valid.ok) {
    // Map public signals back to inputs to learn the order.
    const inv = {};
    const inp = inputs({ salt: "1" });
    for (const [k, v] of Object.entries(inp)) inv[v] = k;
    console.log("\nPublic-signal order mapping (value -> input name):");
    valid.publicSignals.forEach((v, i) => {
      console.log(`  [${i}] ${v}  => ${inv[v] || "(salt or derived)"}`);
    });
  }

  // Trap: approve with recipient mismatch -> must FAIL
  await attempt(
    "TRAP approve w/ recipient mismatch (decision=1, must FAIL)",
    inputs({ recipient: BigInt("0x1111111111111111111111111111111111111111").toString() })
  );
  // Wrong reject: all checks pass but decision=0 -> must FAIL
  await attempt("WRONG reject valid (decision=0, must FAIL)", inputs({ decision: "0" }));
  // Correct reject of trap -> must SUCCEED
  await attempt(
    "CORRECT reject trap (recipient mismatch, decision=0)",
    inputs({
      decision: "0",
      recipient: BigInt("0x1111111111111111111111111111111111111111").toString(),
    })
  );
  // Trap: VK substitution, decision=0 -> must SUCCEED
  await attempt(
    "CORRECT reject VK substitution (decision=0)",
    inputs({
      decision: "0",
      proofVkHash: toField(
        "0xa4c1b8ff00000000000000000000000000000000000000000000000000000000"
      ),
    })
  );
  // Trap: threshold mismatch, decision=0 -> must SUCCEED
  await attempt(
    "CORRECT reject threshold (publicBalance 900 < min 1000, decision=0)",
    inputs({ decision: "0", publicBalance: "900" })
  );
  // Trap: expired, decision=0 -> must SUCCEED
  await attempt(
    "CORRECT reject expired (currentBlock > expiryBlock, decision=0)",
    inputs({ decision: "0", currentBlock: "8430001" })
  );
  // Trap: amount overflow, decision=0 -> must SUCCEED
  await attempt(
    "CORRECT reject amount overflow (amount 1500 > cap 1000, decision=0)",
    inputs({ decision: "0", amount: "1500" })
  );
})();
