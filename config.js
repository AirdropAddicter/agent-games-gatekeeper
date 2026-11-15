// Configuration for the Proof Gatekeeper agent.
// Secrets come ONLY from the .env file (mode 600). Nothing secret lives in code.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

function loadEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(ROOT, ".env"));
const env = { ...fileEnv, ...process.env };

const config = {
  // Port the agent listens on (localhost; a tunnel terminates public HTTPS).
  port: parseInt(env.PORT || "8788", 10),
  host: env.HOST || "127.0.0.1",

  // HMAC secret issued by the platform at agent registration (32 bytes,
  // shown exactly once). PLACEHOLDER until the user registers.
  // The platform signs every task with HMAC-SHA256(secret, rawBody) and
  // expects our responses signed the same way (header x-agent-games-signature).
  hmacSecret: env.AGENT_GAMES_HMAC_SECRET || "",
  hmacSecretIsPlaceholder:
    (env.AGENT_GAMES_HMAC_SECRET || "") === "REPLACE_WITH_PLATFORM_SECRET",

  // Circuit artifacts (official, downloaded from agentgames.zkverify.io).
  wasmPath: path.join(ROOT, "circuits", "gatekeeper.wasm"),
  zkeyPath: path.join(ROOT, "circuits", "gatekeeper_final.zkey"),
  vkPath: path.join(ROOT, "circuits", "verification_key.json"),
  vkHash:
    env.GATEKEEPER_VK_HASH ||
    "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",

  // Persistent state: seen proof_tx refs + cached responses (idempotency).
  // STATE_PATH override exists so tests can use a scratch file.
  statePath: env.STATE_PATH || path.join(ROOT, "data", "state.json"),

  // Internal proving budget. Measured fullProve is ~0.3s (first run ~0.9s);
  // the platform deadline is 60s. 30s leaves ample margin.
  proveTimeoutMs: parseInt(env.PROVE_TIMEOUT_MS || "30000", 10),

  // On-chain check (best-effort, optional — see onchain.js).
  // Kurier API key (free signup at https://kurier.xyz) enables on-chain
  // proof submission/lookup; without it the check is skipped (fail-open,
  // logged). NEVER required for the 7 documented traps (all field-detectable).
  kurierApiKey: env.KURIER_API_KEY || "",
  kurierApiUrl: env.KURIER_API_URL || "https://api.kurier.xyz/api/v1",
  // Set ONCHAIN_CHECK=1 to attempt the best-effort on-chain check when a
  // Kurier key is present. Default 0 (skip) — see onchain.js for why.
  onchainCheckEnabled: env.ONCHAIN_CHECK === "1",

  // taskId -> field element encoding. The platform's exact mapping is NOT
  // publicly documented (see README "Known gaps"). "utf8" = UTF-8 bytes of
  // the task_id string interpreted as a big integer. Alternatives to try
  // against practice mode if the platform rejects proofs: "keccak" (keccak256
  // of the UTF-8 string, mod p), "fnv1a" (64-bit FNV-1a hash).
  taskIdEncoding: env.TASK_ID_ENCODING || "utf8",
};

if (!config.hmacSecret) {
  console.error(
    "[config] WARNING: AGENT_GAMES_HMAC_SECRET is not set. " +
      "HMAC verification will REJECT every request until the real secret " +
      "from agent registration is placed in .env (mode 600)."
  );
}

module.exports = { config, ROOT };
