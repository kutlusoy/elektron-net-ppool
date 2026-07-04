# Miner Compatibility List

Status of known SHA-256d miners against the Elektron Net pool.

## TL;DR

The pool runs **header-only Stratum v1** (`extranonce1 = "" or session tag, extranonce2_size = 0`) because Elektron's
per-block UTXO attestation pins the coinbase to exactly the `getblocktemplate`
bytes — any extranonce splice into `scriptSig` rejects the block as
`bad-utxo-attestation`. A miner is **fully compatible** if its firmware:

1. Respects the pool-advertised `extranonce2_size = 0` (does NOT splice
   anything into the coinbase before computing the merkle root).
2. Does not abort on a session tag in the `extranonce1` slot.
3. Optionally negotiates `mining.configure` version-rolling (BIP310,
   mask `1fffe000`) — the pool supports it; not required.

Anything that hardcodes an extranonce splice independent of the
pool-advertised size is **architecturally incompatible** — the share's
merkle root cannot match the pool's, so no share will ever validate. The
pool keeps these sessions alive in **HOBBY mode** for diagnostics, but
they do not earn rewards.

## Legend

- ✅ **NORMAL** — full compatibility, shares validate, blocks count.
- ⚠️ **HOBBY** — connection stays up, but shares cannot validate because
  the firmware splices into the coinbase regardless of what the pool
  advertises. Connect-only, no rewards. Listed for transparency.
- ❌ **Incompatible** — refuses to connect, or connects but the pool
  cannot handle its protocol expectations.

## Industrial ASIC miners

| Miner | Default firmware | Status | Reason / source |
|---|---|---|---|
| Antminer S9 / S9j | Bitmain stock (cgminer fork) | ✅ NORMAL | cgminer respects pool-advertised `extranonce2_size`; supports `mining.configure`. Set starting diff via password `d=N` per cgminer convention. |
| Antminer S17 / S17 Pro / T17 | Bitmain stock | ✅ NORMAL | Same cgminer lineage. Requires BIP310 version-rolling (`1fffe000`) for full hashrate — pool supports it (`ConfigurationMessage.response()`). |
| Antminer S19 / S19j / S19j Pro / S19 XP | Bitmain stock | ✅ NORMAL | Same. Send higher starting diff (`HOBBY_MINER_DIFFICULTY` does **not** apply — these are not in the hobby allow-list). |
| Antminer S19k Pro / S21 / S21 Pro | Bitmain stock | ✅ NORMAL | Same. |
| Antminer (any) | **Vnish / Braiins OS+** | ✅ NORMAL | Both firmwares are full Stratum v1 conformant; Braiins OS detected by `bosminer`/`bOS` userAgent → tagged `Braiins OS` in pool logs. |
| Whatsminer M20S / M30S / M30S+ / M30S++ | MicroBT stock (BMMiner) | ✅ NORMAL | BMMiner is a cgminer fork; respects `extranonce2_size`. |
| Whatsminer M50 / M50S / M53 / M56 | MicroBT stock | ✅ NORMAL | Same. |
| Avalon A12 / A13 / A14 / A15 series | Canaan stock | ✅ NORMAL | cgminer-derived firmware, standard Stratum v1. |
| Canaan AvalonMiner 1246 / 1346 | Canaan stock | ✅ NORMAL | Same. |
| Innosilicon T3+ / T3 Pro / A11 (SHA256 mode) | Innosilicon stock | ✅ NORMAL | cgminer-derived; standard Stratum v1. |
| Ebang Ebit E11+ / E12+ | Ebang stock | ✅ NORMAL | cgminer-derived. |
| iPollo B1L / B2 | iPollo stock | ✅ NORMAL | cgminer-derived. |

**Notes for industrial ASICs:** The pool calls `getblocktemplate` per
miner (UTXO attestation requires it), so RPC throughput on the Elektron
node — not socket capacity — is the bottleneck. See README §
"Sizing for Elektron Net".

## Hobby / desktop ASIC miners

| Miner | Default firmware | Status | Reason / source |
|---|---|---|---|
| **Bitaxe Ultra / Supra / Gamma / Cobo** | ESP-Miner (open source) | ✅ NORMAL | `bitaxeorg/ESP-Miner` → `components/stratum/stratum_api.c` parses `extranonce_2_len` from the subscribe response and clamps it (max 32) — explicitly accepts `0`. `main/tasks/create_jobs_task.c` `generate_work()` honours `extranonce_2_len` correctly. Removed from `HOBBY_MINER_USER_AGENTS` default in commit `f41f151` precisely for this reason. |
| **NerdMiner v1** (original) | NerdMiner v1.x firmware | ⚠️ HOBBY | Same `calculateMiningData` codepath as v2; assumed equally affected pending verification. |
| **NerdMiner_v2** (BitMaker-hub) | NerdMiner v2.x firmware | ⚠️ HOBBY | `BitMaker-hub/NerdMiner_v2` → `src/utils.cpp` `calculateMiningData()` (~lines 216–226) hardcodes `mWorker.extranonce2 = "00000001"` (4 bytes) whenever `extranonce2_size ∉ {2,4,8}` — including our case of size 0. The 4-byte splice changes the coinbase txid → UTXO attestation fails. Firmware also rejects empty `extranonce1` (`stratum.cpp:78-83`), so the pool sends a non-empty session tag in HOBBY mode to keep the TCP session alive for diagnostics. **No rewards possible** until upstream firmware is fixed. |
| **NerdAxe** | NerdAxe firmware (NerdMiner_v2 fork) | ⚠️ HOBBY | Inherits the `calculateMiningData` codepath from NerdMiner_v2; identical incompatibility assumed. |
| **NerdQAxe / NerdQAxe+** | NerdQAxe firmware (NerdMiner_v2 fork) | ⚠️ HOBBY | Same lineage. |
| **FutureBit Apollo BTC / Apollo II** | Apollo stock (cgminer-based) | ✅ NORMAL | cgminer derivative; respects pool extranonce sizing. |
| **Compass Bitaxe variants** | ESP-Miner | ✅ NORMAL | Same firmware as Bitaxe. |
| Antminer Home (S1 Hydro) | Bitmain stock | ✅ NORMAL | cgminer-derived. |

## CPU and GPU miners (testing / solo mining)

For Elektron Net's network difficulty, CPU and GPU mining is **not
economically meaningful**, but the pool supports them for testing,
solo-mining experimentation, and educational use.

| Miner | Status | Reason / source |
|---|---|---|
| `cpuminer-multi` (tpruvot) | ✅ NORMAL | Standard Stratum v1, respects `extranonce2_size`. The pool sets starting diff to `0.1` automatically when userAgent contains `cpuminer` (`StratumV1Client.ts:420-422`). |
| `cpuminer-opt` (JayDDee) | ✅ NORMAL | Same protocol behaviour as cpuminer-multi. |
| `cgminer` (CPU build) | ✅ NORMAL | The reference Stratum v1 client. |
| `cgminer` (OpenCL/GPU build) | ✅ NORMAL | Same protocol stack, different hashing backend. |
| `bfgminer` | ✅ NORMAL | Standard Stratum v1, supports `mining.configure`. |
| `sgminer` (GPU, SHA256d build) | ✅ NORMAL | cgminer fork; standard Stratum v1. |
| `ckpool` / `ckminer` (solo client) | ✅ NORMAL | Standard Stratum v1; pool will validate shares from a chained client. |
| Python `mining/miner.py` (Elektron reference miner) | ✅ NORMAL | The byte-for-byte reference the pool's coinbase builder is annotated against (`MiningJob.ts` mirrors `_build_coinbase_tx`). Use this for any first-line debugging. |

## How the pool decides NORMAL vs HOBBY

`src/models/StratumV1Client.ts` (~line 891) reads
`HOBBY_MINER_USER_AGENTS` (comma-separated substrings, case-insensitive)
from the environment and tags a session HOBBY if the userAgent contains
any listed substring. Current default (`.env.example`):

```
HOBBY_MINER_USER_AGENTS=NerdMiner,NerdminerV2,nerdminer,NerdAxe,NerdQAxe
HOBBY_MINER_DIFFICULTY=0.001
```

HOBBY sessions get:
- `extranonce1 = <session id>` (non-empty) in the subscribe response so
  the firmware does not abort on empty extranonce1.
- Starting difficulty `HOBBY_MINER_DIFFICULTY` (default `0.001`) so an
  ESP32-class device actually finds a share before the dead-client
  timeout fires.

NORMAL sessions get:
- `extranonce1 = ""` in the subscribe response (canonical, miner.py-equivalent).
- Default `sessionDifficulty` (or `0.1` if userAgent is `cpuminer`).

Both modes always use `extranonce2_size = 0` (constant in `stratum.constants.ts`).

## Adding a new miner

1. Connect the miner; the pool logs `New client ID: <id>, ua=<userAgent>`
   and a `mode=NORMAL|HOBBY` tag on `mining.submit`.
2. If shares are rejected as `diff=0.000000`, enable diagnostic logging
   to identify the splice the firmware performs:
   ```
   DIAGNOSTIC_SHARE_LOGGING_MODES=canonical,suffix-en1,suffix-en1-en2,suffix-en1-default-en2,scriptsig-en1
   ```
   Watch the `[diag]` lines: whichever mode reports `diff >= required` is
   the splice the firmware is doing.
3. If the matching mode is anything other than `canonical`, the miner
   is **architecturally incompatible** with the Elektron Net pool —
   document the userAgent and the splice pattern here, add the
   userAgent substring to `HOBBY_MINER_USER_AGENTS` to keep the
   connection alive (no rewards), and file an upstream firmware issue.
4. If `canonical` matches but shares still don't count, the firmware is
   likely aborting on empty `extranonce1` before submitting — add to
   `HOBBY_MINER_USER_AGENTS`; this is the case in which HOBBY mode
   actually helps and shares may validate.

## Pool capability summary

What the pool implements on the Stratum-v1 side (verified in `main`
HEAD `4cb37f8`):

- `mining.subscribe` with per-session NORMAL/HOBBY response split.
- `mining.authorize` with optional `d=N` starting-difficulty hint in
  the password field (cgminer convention).
- `mining.configure` advertising `version-rolling=true,
  mask=1fffe000` (BIP310 overt AsicBoost) — `ConfigurationMessage.ts`.
- `mining.suggest_difficulty` — accepted, sets sessionDifficulty.
- `mining.notify` with `clean_jobs` set on new-block boundaries.
- `mining.set_difficulty` adaptive vardiff via `checkDifficulty()`
  on a 60 s timer.
- `mining.submit` with `versionMask` (BIP310 version-rolling field).
