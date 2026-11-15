// Persistent state: seen proof_tx references (PROOF_REUSED detection) and
// cached responses keyed by task_id (idempotency — the platform may retry
// a task after a network failure and must get the byte-identical response).
//
// Both live in ONE JSON file written atomically (temp file + rename) so a
// crash can never leave "proof marked seen" without "response cached" —
// otherwise a retried task would be wrongly rejected as PROOF_REUSED.
//
// Only competition-mode tasks are recorded. Practice tasks are excluded on
// purpose: if practice reuses the same proof_tx pool as competition,
// recording them would cause false PROOF_REUSED rejects in scored rounds.
// (Assumption — see README "Known gaps".)
const fs = require("fs");
const path = require("path");
const { config } = require("./config");

function load() {
  try {
    const raw = fs.readFileSync(config.statePath, "utf8");
    const data = JSON.parse(raw);
    return {
      seenProofTx: new Set(data.seenProofTx || []),
      responses: new Map(Object.entries(data.responses || {})),
    };
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`[store] WARNING: could not read state file: ${e.message}. Starting empty.`);
    }
    return { seenProofTx: new Set(), responses: new Map() };
  }
}

let state = load();

function save() {
  const dir = path.dirname(config.statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = config.statePath + ".tmp";
  const data = {
    seenProofTx: [...state.seenProofTx],
    responses: Object.fromEntries(state.responses),
  };
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, config.statePath);
}

function hasSeenProofTx(proofTx) {
  return state.seenProofTx.has(String(proofTx).trim().toLowerCase());
}

function getCachedResponse(taskId) {
  return state.responses.get(taskId) || null;
}

// Record a completed task atomically: its proof_tx joins the seen-set and
// its exact response body is cached for replays. Call AFTER the response
// is fully built (and only for competition-mode tasks).
function recordTask({ taskId, proofTx, responseBody, mode }) {
  if (mode && mode !== "competition") return; // practice tasks: not recorded
  if (taskId) state.responses.set(taskId, responseBody);
  if (proofTx) state.seenProofTx.add(String(proofTx).trim().toLowerCase());
  save();
}

function stats() {
  return { seenProofTx: state.seenProofTx.size, cachedResponses: state.responses.size };
}

// Test hook: reset in-memory state (does not delete the file).
function _resetForTests() {
  state = { seenProofTx: new Set(), responses: new Map() };
}

module.exports = { hasSeenProofTx, getCachedResponse, recordTask, stats, _resetForTests };
