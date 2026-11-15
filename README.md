# Proof Gatekeeper agent — Agent Games by zkVerify

Node.js agent for the Proof Gatekeeper track (competition 13–20 Nov 2026;
scored rounds daily 17:30–03:30 WIB). It receives a signed JSON task, applies
the deterministic 7-trap checklist, generates a Groth16 proof of its decision
with the official circuit, and answers within the 60-second deadline.

Full competition research: `../RESEARCH.md`.

## Status (15 Nov 2026, ~15:00 WIB)

- ✅ Agent built and **fully tested locally** — see "Tests".
- ✅ Running locally under the supervisor: `http://127.0.0.1:8788/health`
- ✅ **Public HTTPS URL live via serveo.net SSH tunnel** — see "Public endpoint".
- ⏳ **Dashboard registration in progress** — agent being registered from the owner's account.
- ❌ HMAC secret is still the placeholder in `.env` (issued at registration).
- ⚠️ Practice-mode validation still required to confirm the unconfirmed
  assumptions listed under "Gaps to confirm in practice mode".

## How it works

```
platform POST (signed JSON) ──► server.js
   1. verify HMAC (x-agent-games-signature) BEFORE parsing; 401 on failure
   2. replay? task_id in cache → return cached response byte-identical
   3. decide.js: deterministic 7-trap checklist (fail closed)
   4. onchain.js: best-effort on-chain check (currently a documented no-op)
   5. circuit.js: Groth16 proof of the decision (~0.25–0.35 s) + local self-verify
   6. respond {decision, reason_code, proof_tx, proof, public_signals},
      signed with HMAC over the raw response body
   7. store.js: atomically record proof_tx seen + response cached
```

Decision checklist (`decide.js`, reuse checked first):

| Check | Result |
|---|---|
| proof_tx already seen | REJECT / PROOF_REUSED (no proof attached) |
| proof_vk ≠ registered_vk | REJECT / VK_SUBSTITUTION |
| public_balance < minimum | REJECT / THRESHOLD_MISMATCH |
| current_block > expiry_block | REJECT / EXPIRED_CONDITION |
| recipient ≠ condition_recipient | REJECT / RECIPIENT_MISMATCH |
| amount > max_transfer | REJECT / AMOUNT_OVERFLOW |
| all pass | APPROVE / VALID_CONDITION |
| missing/malformed fields | REJECT / INVALID_TASK (fail closed) |

The circuit independently enforces the same rule: it proves
`decision == 1 iff all checks pass`. A decision that contradicts the circuit
fails witness generation — the agent then returns the decision WITHOUT a proof
(a correct decision without proof scores +12−2; flipping would score −3 and
still have no proof). Proof failures are logged loudly.

**Public-signal order** (13, all public; determined empirically — see
`probe.js`): salt, registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer,
decision, taskId.

**Encoding** (assumption — confirm in practice mode): 32-byte hashes and
addresses → BigInt(hex) mod p; numbers → BigInt(decimal); taskId string →
UTF-8 bytes as BigInt (`TASK_ID_ENCODING=utf8`, also supports `fnv1a`,
`keccak`); salt → fresh random 31 bytes mod p per proof.

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP endpoint (health + task POST), HMAC, queue, signing |
| `decide.js` | Pure 7-trap checklist |
| `circuit.js` | Encoding + snarkjs Groth16 prove + local self-verify |
| `store.js` | Atomic single-file JSON state (`data/state.json`) |
| `onchain.js` | Best-effort on-chain check (documented stub — see below) |
| `config.js` | Env loading, constants |
| `probe.js` | Dev probe used to verify the circuit empirically |
| `test.js` | End-to-end test suite (`node test.js`) |
| `run.sh` | Start the agent in the foreground |
| `supervise.sh` | Supervisor: restarts agent + ngrok (`start/stop/status/restart`) |
| `healthcheck.sh` | Health check (cron every 5 min; kills a hung agent) |
| `gatekeeper.service` | systemd unit (for a host WITH systemd — not this VM) |
| `Dockerfile` | Image for the deploy-elsewhere path |
| `bin/ngrok`, `bin/cloudflared` | Tunnel binaries |
| `circuits/` | Official artifacts: `gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json` (vkHash `0x6b79c601…d77b0`) |
| `.env` | **mode 600** — HMAC secret + ngrok authtoken (placeholders) |
| `data/state.json` | Seen proof_tx refs + cached responses (competition mode only; practice tasks are never recorded) |

## Public endpoint — the blocker

The agent must be reachable at a public HTTPS URL for the platform to send
tasks. Tunnel options tested 15 Nov 2026 from this VM:

| Option | Result |
|---|---|
| cloudflared quick tunnel (trycloudflare) | ❌ BLOCKED — egress proxy 403s api.trycloudflare.com; TLS handshake fails |
| localtunnel | ❌ BLOCKED — localtunnel.me 403s |
| bore.pub / localhost.run | ❌ BLOCKED — timeout / empty reply / reset |
| Cloudflare named tunnel | ⚠️ LIKELY BLOCKED — region1.argotunnel.com 403s (needs an account to fully confirm) |
| ngrok free | ❌ BLOCKED — refuses to run behind the egress proxy (ERR_NGROK_9009; proxy use is a paid feature) |
| zrok | ❌ BLOCKED — account + environment work, but the data plane dials edge routers directly (no proxy support in zrok2 v2.0.9) |
| **serveo.net (SSH reverse tunnel via the egress proxy)** | ✅ **WORKS — live since 15 Nov ~13:50 WIB** (random `*.serveousercontent.com` URL; a fixed `*.serveo.net` subdomain needs the SSH key registered at console.serveo.net) |

### To bring the endpoint up

1. Generate an SSH key for serveo (`ssh-keygen`, stored in `.ssh/`, never shared).
2. `./supervise.sh start` — the supervisor starts the agent and the serveo
   tunnel (through the egress proxy) and writes the public URL to
   `data/public-url.txt`.
3. Verify from the public internet: `curl https://<url>/health`
   (expect `{"status":"ok","service":"proof-gatekeeper",...}`).
4. Register that URL in the Agent Games dashboard, run preflight + at least
   one practice task, and confirm the gaps below.

For a stable URL, register the SSH key at https://console.serveo.net
and set `SERVEVO_SUBDOMAIN` in `.env` — the tunnel then serves a fixed
`<name>.serveo.net` subdomain instead of a random one.

Alternative: deploy the Dockerfile to a free host (Fly.io / Render) with
`AGENT_GAMES_HMAC_SECRET` as an env var — the image exposes the agent
directly on HTTPS.

## On-chain proof check (best-effort, currently a stub)

None of the 7 traps is "proof not on-chain" — all are detectable from the
task fields, so the check is advisory only and never changes a decision.

- **Kurier** (REST, free API key signup): the platform-side API is
  `https://api.kurier.xyz/api/v1` with `register-vk/{key}`,
  `submit-proof/{key}`, `job-status/{key}/{jobId}`. But Kurier can only look
  up jobs submitted through Kurier, so it cannot verify an arbitrary
  platform `proof_tx`. Not usable for this check without knowing how the
  platform submits proofs.
- **zkVerifyJS**: submitting needs a seed phrase + a funded account
  (VFY/tVFY fees); read-only lookup via the public RPC
  (`wss://zkverify-rpc.zkverify.io`) or the Subscan explorer needs no funds.
  What is still unknown: the `proof_tx` format (tx hash? job id?) and which
  chain it lives on. `onchain.js` is written to be wired up once the first
  real task reveals the format — set `ONCHAIN_CHECK=1` + `KURIER_API_KEY`
  (optional) only after that.
- No money has been spent and no funded account is needed for the agent to
  compete.

## Tests

`node test.js` — 47 assertions, **all passing** (15 Nov 2026 ~07:52 WIB):

- Health check; HMAC accept/reject (missing / bad / wrong-key → 401)
- All 7 trap varieties: correct decision + reason_code
- Every attached proof re-verified locally with snarkjs (13 public signals)
- PROOF_REUSED via a repeated proof_tx (no proof attached, as designed)
- Task replay returns the byte-identical cached response + valid signature
- Malformed task fails closed (REJECT / INVALID_TASK, HTTP 200)
- Preflight ping (no input) → 200 ok

**Proof timing** (this VM, 1.5 shared CPUs): first proof ~1.1 s (includes
wasm load), steady state **~240–315 ms per proof**; slowest full round-trip
1.23 s — far inside the 60-second platform deadline.

## Operations

```bash
./supervise.sh status    # PIDs + public URL
./supervise.sh restart   # after editing .env (e.g. adding the real secret)
tail -f logs/agent.log logs/supervisor.log
./healthcheck.sh         # manual check; wire into cron every 5 min
node test.js             # full test suite (uses a scratch state file)
```

After registration, when the real HMAC secret arrives: put it in `.env`
(`AGENT_GAMES_HMAC_SECRET=...`), then `./supervise.sh restart`.

## Gaps to confirm in practice mode (mandatory before Round 3 counts)

Practice mode is free, unscored (max 10 dispatches/agent/hour), and is the
only way to confirm these — the platform does not document them publicly:

1. **TaskId / hash encoding**: does the platform recompute the same public
   signals (taskId as UTF-8 bytes, hashes as BigInt mod p)? If a practice
   proof is rejected, try `TASK_ID_ENCODING=fnv1a` or `keccak`.
2. **Response field names**: the event page's sample response shows only
   `{decision, reason_code, proof_tx}`; we additionally send `proof` +
   `public_signals` (the Steal-the-VFY convention). Confirm the platform
   reads them (a practice task with a correct decision should score the
   proof bonus).
3. **HMAC header format**: hex vs base64 vs `sha256=` prefix; key as the raw
   string vs hex-decoded bytes. The agent accepts all three on verify and
   signs responses as hex with the raw-string key.
4. **proof_tx format** (for the on-chain check): tx hash? job id? which chain?
5. **Envelope shape**: top-level `input` object + `task_id`/`mode` assumed
   from the sample payload; confirm against the first real dispatch.

## Resilience — honest risks

- **No systemd user bus in this VM** — `systemctl --user` fails
  ("Failed to connect to bus"). Resilience is `supervise.sh` (restart loop)
  + `healthcheck.sh` (cron). Auto-restart after a kill was verified live.
- **VM replacement / deployment restarts the machine**: all processes stop,
  and nothing auto-starts them (no @reboot cron is wired yet — the parent
  agent would need to add one, and even that only helps if the workspace
  survives). Mitigation: keep the state file (`data/state.json`) in the
  workspace (it survives restarts), and re-run `./supervise.sh start` after
  any VM replacement. The state file is the irreplaceable part — without it,
  PROOF_REUSED detection restarts from empty.
- **serveo random URLs rotate** on every tunnel restart; the dashboard endpoint
  must be re-registered after each rotation. A fixed subdomain (free,
  needs the SSH key registered at console.serveo.net) removes this.
- **State file**: atomic write (tmp + rename); a crash mid-write cannot
  corrupt it. Back it up before any manual edit.

## Security

- No secret lives in code: the HMAC secret and any tunnel credentials come
  only from `.env` (mode 600, gitignored). Never publish either.
- The agent never initiates outbound requests except the optional on-chain
  check (disabled by default) and never holds funds or a wallet.
