// Pure decision logic: the 7-trap checklist from the official event page
// (https://agentgames.zkverify.io/events/proof-gatekeeper).
//
// Trap encyclopedia (all detectable from the task fields alone):
//   VALID_CONDITION    ~50%  approve — every check passes
//   VK_SUBSTITUTION    ~13%  reject — proof_vk != registered_vk
//   THRESHOLD_MISMATCH ~8%   reject — public_balance < minimum
//   PROOF_REUSED       ~11%  reject — proof_tx seen in a previous task
//   EXPIRED_CONDITION  ~6%   reject — current_block > expiry_block
//   RECIPIENT_MISMATCH ~6%   reject — recipient != condition_recipient
//   AMOUNT_OVERFLOW    ~6%   reject — amount > max_transfer
//
// Check order matters only for the reason_code when several traps coincide
// (the platform's ground truth has one trap per task, but be deterministic):
// reuse is checked first (it also has no proof to generate), then the
// field checks in the order the event page lists them.
// Fail closed: missing/malformed fields => REJECT with INVALID_TASK.
const REQUIRED_FIELDS = [
  "registered_vk",
  "proof_vk",
  "minimum",
  "public_balance",
  "expiry_block",
  "current_block",
  "recipient",
  "condition_recipient",
  "amount",
  "max_transfer",
  "proof_tx",
];

function normHex(v) {
  return String(v).trim().toLowerCase();
}

// input: task.input object. hasSeenProofTx: (proofTx) => boolean.
// Returns { decision: "APPROVE"|"REJECT", reason_code }.
function decide(input, hasSeenProofTx) {
  if (!input || typeof input !== "object") {
    return { decision: "REJECT", reason_code: "INVALID_TASK" };
  }
  for (const f of REQUIRED_FIELDS) {
    if (input[f] === undefined || input[f] === null || input[f] === "") {
      return { decision: "REJECT", reason_code: "INVALID_TASK" };
    }
  }

  // Numeric fields must parse as integers; otherwise fail closed.
  let minimum, publicBalance, expiryBlock, currentBlock, amount, maxTransfer;
  try {
    minimum = BigInt(input.minimum);
    publicBalance = BigInt(input.public_balance);
    expiryBlock = BigInt(input.expiry_block);
    currentBlock = BigInt(input.current_block);
    amount = BigInt(input.amount);
    maxTransfer = BigInt(input.max_transfer);
  } catch {
    return { decision: "REJECT", reason_code: "INVALID_TASK" };
  }

  // 1. Proof reuse — checked first; a reused proof has no proof to submit
  // (the platform excludes PROOF_REUSED tasks from the proof bonus).
  if (hasSeenProofTx && hasSeenProofTx(normHex(input.proof_tx))) {
    return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  }

  // 2. Verification-key substitution.
  if (normHex(input.proof_vk) !== normHex(input.registered_vk)) {
    return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  }

  // 3. Threshold mismatch.
  if (publicBalance < minimum) {
    return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  }

  // 4. Expired condition (block-height expiry has passed).
  if (currentBlock > expiryBlock) {
    return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };
  }

  // 5. Recipient mismatch.
  if (normHex(input.recipient) !== normHex(input.condition_recipient)) {
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  }

  // 6. Amount overflow (single-transfer cap).
  if (amount > maxTransfer) {
    return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  }

  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}

module.exports = { decide, REQUIRED_FIELDS };
