// Best-effort on-chain verification of the task's proof reference.
//
// The build checklist says "Call zkVerifyJS to confirm the proof is
// on-chain and its VK matches the registered condition VK". In practice:
//
// 1. NONE of the 7 documented trap varieties is "proof not on-chain" —
//    every trap is detectable from the task fields alone. The on-chain
//    check is defense-in-depth, not required for scoring.
// 2. The proof_tx format is unknown until the first real task arrives
//    (the sample payload truncates it: "0xa4c1...8ff1"). It may be a
//    zkVerify extrinsic hash, an attestation id, or a Kurier job id —
//    each needs a different lookup.
// 3. Lookup options and what each needs:
//    - Kurier REST (https://api.kurier.xyz/api/v1): needs a FREE API key
//      (signup at https://kurier.xyz). But Kurier's API looks up jobs
//      submitted THROUGH Kurier (job-status by jobId); it cannot look up
//      an arbitrary proof_tx the platform created. Useful only if the
//      platform's proof_tx values are Kurier job ids (unknown).
//    - zkVerify mainnet RPC (wss://zkverify-rpc.zkverify.io) via
//      @polkadot/api: read-only extrinsic lookup needs NO funds and NO
//      account — but needs the @polkadot/api dependency and the exact
//      pallet/extrinsic layout. Submitting proofs (zkVerifyJS Volta
//      sessions) DOES need a funded account (VFY for fees) — not needed
//      for a read-only check.
//    - Explorer https://zkverify.subscan.io (Subscan API needs an API key
//      for programmatic use).
//
// So this module is intentionally a documented stub: it attempts nothing
// by default and always resolves { checked: false, reason } — the agent
// proceeds on the field checks (fail-open for the on-chain check only,
// fail-closed everywhere else). Wire a real lookup here once the
// proof_tx format is known from a real practice task and a lookup
// credential (if any) is available.
const { config } = require("./config");

// Returns { checked: boolean, onChain?: boolean, reason: string }.
async function checkProofOnChain(proofTx) {
  if (!config.onchainCheckEnabled) {
    return { checked: false, reason: "on-chain check disabled (ONCHAIN_CHECK != 1)" };
  }
  if (!config.kurierApiKey) {
    return { checked: false, reason: "no KURIER_API_KEY configured" };
  }
  // NOTE: no lookup is implemented yet — see the header comment. When the
  // proof_tx format is known, implement the lookup here (Kurier job-status
  // if proof_tx is a Kurier job id, else @polkadot/api extrinsic lookup
  // against wss://zkverify-rpc.zkverify.io) and return
  // { checked: true, onChain: true|false }.
  return { checked: false, reason: "lookup not implemented (proof_tx format unknown)" };
}

module.exports = { checkProofOnChain };
