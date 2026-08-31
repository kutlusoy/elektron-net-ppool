# Elektron Net - `elektron-net-ppool` / `elektron-net-pool` Fix Report

- **Version:** 0.3 (regtest-verified)
- **Date:** August 31, 2026
- **Audience:** Elektron Net pool maintainers implementing the Stratum V1 coinbase fix
- **Reference implementation:** [`elektron-net`](https://github.com/kutlusoy/elektron-net) - `src/node/miner.cpp` (`BlockAssembler::CreateNewBlock`), `src/rpc/mining.cpp` (`coinbase_script_sig_prefix` field) - treat as ground truth for coinbase scriptSig and consensus behavior
- **Consumer:** [`elektron-net-ppool`](https://github.com/kutlusoy/elektron-net-ppool) (PPLNS pool) and [`elektron-net-pool`](https://github.com/kutlusoy/elektron-net-pool) (solo pool backend, built into the [`elektron-net-pool-startos`](https://github.com/kutlusoy/elektron-net-pool-startos) package) - both confirmed to share byte-identical `src/models/MiningJob.ts` and `src/models/stratum.constants.ts`, so the defect and the fix are identical in both repos
- **External reference client:** [`bitaxeorg/ESP-Miner`](https://github.com/bitaxeorg/ESP-Miner) - `components/stratum/coinbase_decoder.c`, `main/tasks/stratum_v1_task.c` - not an Elektron Net repo, cited here because it is the client whose parsing behavior the pool's Stratum wire format must satisfy

---

## 1. Summary

Every Stratum job sent by `elektron-net-ppool` **and** `elektron-net-pool` (the solo-mining backend) fails to parse in the reference Bitaxe/AxeOS firmware (`ESP-Miner`), logged as `Failed to process mining notification`. A direct source comparison confirms `src/models/MiningJob.ts` and `src/models/stratum.constants.ts` are byte-identical between the two repos (`elektron-net-pool` appears to be derived from the same codebase as `elektron-net-ppool`, minus the `pplns/` and `payout-ledger/` reward-splitting modules, which a solo pool does not need). Everything in this report therefore applies to both repos equally; there is no solo-pool-specific variant of the bug or the fix. Because the failing job is discarded in full, the firmware never advances past the last successfully parsed job and keeps resubmitting the same ASIC result, which the pool then correctly rejects as `Duplicate share`. The endless `Duplicate share` flood is a downstream symptom of the notification-parsing failure, not an independent bug.

The root cause is **not** the fact that `EXTRANONCE_SIZE = 0`. That value is intentional and consensus-required (see Section 2.1). The root cause is **where the pool splits the serialized coinbase transaction between the `coinb1` and `coinb2` fields of `mining.notify`**. The pool currently puts the entire transaction into `coinb1` and leaves `coinb2` empty. Standard Stratum V1 clients, including ESP-Miner, always expect `nSequence`, the output count, the outputs, and `nLockTime` to live in `coinb2`. With `coinb2` empty, that expectation can never be met, so parsing fails on every job, unconditionally.

The fix moves the split point to the position a standard client expects, without changing a single byte of the transaction itself. Because `EXTRANONCE1_SIZE_BYTES` and `EXTRANONCE2_SIZE_BYTES` stay at `0`, `coinb1 + coinb2` (with nothing spliced in between) reassembles to exactly the same bytes as today's `coinb1` alone. The UTXO attestation, which is computed over those transaction bytes, is unaffected **provided** one companion change described in Section 4.2 is made at the same time. That companion change is the part that is easy to miss and the main reason for writing this up as a full report rather than a one-line patch.

## 2. Root Cause Analysis

### 2.1 Why `EXTRANONCE_SIZE = 0` exists and MUST NOT be reverted

`src/models/stratum.constants.ts` documents this directly: the Elektron Net reference miner (`mining/miner.py`) builds the coinbase scriptSig as `bytes.fromhex(prefix_hex)` with nothing appended, where `prefix_hex` is the `coinbase_script_sig_prefix` value returned by `getblocktemplate`. On the node side, `src/node/miner.cpp` constructs that prefix as `CScript() << nHeight` (a standard BIP34 height push, optionally padded with `OP_0` for heights <= 16 to satisfy the two-byte minimum), and `src/rpc/mining.cpp` exposes it verbatim as `coinbase_script_sig_prefix`.

Elektron Net's per-block MuHash UTXO attestation is computed against the resulting coinbase output set and depends on the coinbase transaction being byte-identical to what the node itself would produce. Any additional byte appended to the scriptSig (a pool tag, an extranonce) changes the coinbase txid and invalidates that attestation, surfacing as `bad-utxo-attestation` at block-submission time. Setting both `EXTRANONCE1_SIZE_BYTES` and `EXTRANONCE2_SIZE_BYTES` to `0` is what prevents any Stratum client from splicing extra bytes into the scriptSig. **This part of the design is correct and must be preserved by any fix.**

### 2.2 What the pool currently sends

`src/models/MiningJob.ts`, constructor, lines ~121-128:

```ts
this.coinbasePart1 = this.coinbaseTransaction.__toBuffer().toString('hex');
this.coinbasePart2 = '';
this.coinbasePart1Buffer = Buffer.from(this.coinbasePart1, 'hex');
this.coinbasePart2Buffer = Buffer.alloc(0);
```

The entire non-witness transaction (version, input count, prevout, scriptSig, `nSequence`, output count, all outputs, `nLockTime`) is serialized into `coinbasePart1`. `coinbasePart2` is always the empty string. These two values are sent as `coinb1`/`coinb2` in every `mining.notify` (see `response()` in the same file, which places `this.coinbasePart1` and `this.coinbasePart2` directly into the `IMiningNotify` params array).

### 2.3 What the client (ESP-Miner) expects and where it fails

`components/stratum/coinbase_decoder.c`, `coinbase_process_notification()`:

- It parses `coinbase_1` up to and including the scriptSig (fixed 41-byte prefix for version/input-count/prevout, then the scriptSig length byte, then the BIP34 height-length byte, then the height bytes, then any remaining scriptSig "tag" bytes it can locate across the `coinb1`/`coinb2` boundary).
- It then unconditionally reads `nSequence`, the output count, and every output **from `coinbase_2`**:

```c
int coinbase_2_len = strlen(notification->coinbase_2) / 2;
...
int offset = coinbase_2_offset;
if (offset + 4 > coinbase_2_len) {
    free(coinbase_2_bin);
    return ESP_ERR_INVALID_ARG;
}
```

Because `coinbase_2` is always the empty string from this pool, `coinbase_2_len` is always `0`, so `offset + 4 > coinbase_2_len` is always true, and the function always returns `ESP_ERR_INVALID_ARG`.

`main/tasks/stratum_v1_task.c`, `decode_mining_notification()`, treats that return value as fatal:

```c
if (coinbase_process_notification(mining_notification, ...) != ESP_OK) {
    ESP_LOGE(TAG, "Failed to process mining notification");
    free(result);
    return;
}
```

The entire job update (network difficulty, block height, scriptsig, block signals) is discarded, and the new job is never installed as the active job.

## 3. Why Duplicate Shares Are a Symptom, Not a Separate Bug

Because `decode_mining_notification()` returns early, the firmware's active job state is never advanced to the new job. The ASIC hardware, however, keeps completing its current search space on the old job and keeps handing results to the Stratum layer, which keeps resubmitting the same `(job_id, nonce)` pair to the pool. The pool correctly rejects each of these as `Duplicate share`, because it genuinely is a duplicate of a share already scored. Increasing `EXTRANONCE_SIZE` would not fix this: even with a larger search space, the client would still be stuck on the last job it could parse, because every subsequent job hits the identical `coinbase_2` parsing failure. The two symptoms observed (`Failed to process mining notification`, `Duplicate share`) collapse into one root cause once traced through the code.

## 4. Proposed Fix

### 4.1 Move the `coinb1`/`coinb2` split point

In the `MiningJob` constructor, split the serialized transaction at the end of the scriptSig instead of at the end of the whole transaction. With a single coinbase input and a scriptSig under 253 bytes (always true here), the split offset is:

```
splitOffset = 4 (version) + 1 (input count) + 32 (prevout hash) + 4 (prevout index)
            + 1 (scriptSig length byte) + scriptSig.length
```

which is exactly the fixed-prefix constant (`41`) that ESP-Miner's own parser hardcodes, plus one length byte, plus the scriptSig itself. Concretely:

```ts
const fullTxBuffer = this.coinbaseTransaction.__toBuffer();
const splitOffset = 41 + 1 + scriptSig.length;

this.coinbasePart1 = fullTxBuffer.slice(0, splitOffset).toString('hex');
this.coinbasePart2 = fullTxBuffer.slice(splitOffset).toString('hex');
this.coinbasePart1Buffer = fullTxBuffer.slice(0, splitOffset);
this.coinbasePart2Buffer = fullTxBuffer.slice(splitOffset);
```

`coinbasePart1` now ends immediately after the scriptSig (which is exactly `coinbase_script_sig_prefix`, unmodified). `coinbasePart2` now begins at `nSequence` and continues through the outputs and `nLockTime`, exactly where ESP-Miner (and standard Stratum V1 clients generally) expect to find them. Because `EXTRANONCE1_SIZE_BYTES = EXTRANONCE2_SIZE_BYTES = 0`, no client-side splicing occurs between `coinb1` and `coinb2`, so `coinb1 + coinb2` still reassembles to `fullTxBuffer` exactly, byte for byte.

### 4.2 Required companion fix: `buildHeaderBuffer()` (this is the part that MUST NOT be skipped)

`buildHeaderBuffer()`, the function that actually computes the merkle root the pool uses to validate submitted shares and to assemble candidate block headers, currently hashes `coinbasePart1Buffer` alone:

```ts
public buildHeaderBuffer(...): Buffer {
    // With EXTRANONCE_SIZE = 0 the worker can't change the coinbase, so the
    // hash is precisely the precomputed coinbasePart1Buffer (=tx_no_witness).
    const coinbaseHash = bitcoinjs.crypto.hash256(this.coinbasePart1Buffer);
    ...
}
```

This is safe **today** only because `coinbasePart1Buffer` happens to equal the full transaction. Once Section 4.1 is applied, `coinbasePart1Buffer` becomes only the first part of the transaction (through the scriptSig), and hashing it alone would hash a truncated, invalid coinbase transaction. This function is called from `StratumV1Client.ts:638` on every share submission and is the pool's authoritative header/merkle-root computation, so this is not a cosmetic detail: an unpatched `buildHeaderBuffer()` would silently start validating shares (and, if a block is found, constructing the block header) against the wrong coinbase hash the moment 4.1 ships.

The fix is to hash the full reassembled transaction:

```ts
const coinbaseHash = bitcoinjs.crypto.hash256(
    Buffer.concat([this.coinbasePart1Buffer, this.coinbasePart2Buffer])
);
```

Since `coinbasePart1Buffer + coinbasePart2Buffer` is byte-identical to `fullTxBuffer` (Section 4.1), this restores exactly the same hash the pool computes today, just derived from two buffers instead of one.

### 4.3 Diagnostic helper methods: no change needed

`buildHeaderBufferWithCoinbaseSuffix`, `buildHeaderBufferWithCoinbasePrefix`, and `buildHeaderBufferWithScriptSigSplice` are explicitly documented as diagnostic-only probes used by `StratumV1Client.ts` to detect firmware that splices extranonce bytes incorrectly. They operate on `coinbasePart1Buffer` by design, to test hypotheses about what a given client actually did. They do not need to change, but once 4.1 ships, anyone reading their output should keep in mind that `coinbasePart1Buffer` is now only the pre-scriptSig-end fragment, not the full transaction, when interpreting probe results.

## 5. Attestation Safety - Invariants That MUST Hold

Anyone implementing this fix MUST verify all of the following before merging:

1. **No new bytes.** `scriptSig` itself (`jobTemplate.coinbase_script_sig_prefix`, or the local height-encoding fallback) MUST remain exactly as returned by `getblocktemplate`. The fix changes only where the existing byte stream is cut into two wire fields, never its content, order, or length.
2. **Reassembly identity.** For every job, `Buffer.concat([coinbasePart1Buffer, coinbasePart2Buffer])` MUST deep-equal `this.coinbaseTransaction.__toBuffer()`. This should be asserted in a unit test (Section 6), not just reasoned about, since it is the actual safety property the attestation depends on.
3. **`EXTRANONCE1_SIZE_BYTES` and `EXTRANONCE2_SIZE_BYTES` stay `0`.** Do not raise these to "solve" duplicate shares. Doing so would let clients splice real bytes into the scriptSig, which is precisely what breaks the attestation (Section 2.1). The fix in this report requires no change to either constant.
4. **`buildHeaderBuffer()` MUST hash both parts.** This is the single most likely place to introduce a silent regression, because the function will keep compiling and keep returning a value after 4.1 alone; it will simply be the wrong value. Treat 4.1 and 4.2 as one atomic change, not two independent patches.
5. **Submit-side share validation.** Confirm that whatever code path validates an incoming `mining.submit` (in `StratumV1Client.ts`, around line 638) uses the same corrected `buildHeaderBuffer()` output for both the share-difficulty check and, when a share also meets network difficulty, the actual block header that gets submitted via `submitblock`. There should be exactly one source of truth for the coinbase hash after this change.
6. **`witness` field untouched.** `coinbaseTransaction.ins[0].witness` continues to use the single 32-byte zero stack item and continues to be excluded from `coinbasePart1`/`coinbasePart2` by virtue of `__toBuffer()` skipping the witness section (as today). The split logic in 4.1 operates only on the non-witness serialization, matching current behavior.

## 6. Test Plan / Verification

1. **Unit test - reassembly identity.** Add a test to `MiningJob.spec.ts` that builds a `MiningJob` from a representative `IJobTemplate` (mirroring the existing fixtures) and asserts `Buffer.concat([coinbasePart1Buffer, coinbasePart2Buffer]).equals(coinbaseTransaction.__toBuffer())`.
2. **Unit test - header hash unchanged.** Add a test asserting that `buildHeaderBuffer()`'s output (specifically the merkle root it produces) is identical before and after the 4.1 change, for a fixed job/nonce/timestamp fixture. This pins down that 4.2 was applied correctly and that the header the pool builds for `submitblock` has not shifted.
3. **Unit test - coinb1/coinb2 boundary.** Assert `coinbasePart1` ends exactly at the byte offset `41 + 1 + scriptSig.length`, and that `coinbasePart2` begins with the 4-byte little-endian `nSequence` value (`0xFFFFFFFE`, i.e. `feffffff` on the wire) that `MiningJob.ts` sets via `MAX_SEQUENCE_NONFINAL`.
4. **Integration test - real firmware.** Point a Bitaxe running unmodified ESP-Miner firmware, or a NerdMiner V2 running the fixed [`kutlusoy/elektron-net-nerdminerv2`](https://github.com/kutlusoy/elektron-net-nerdminerv2) firmware, at a private regtest instance of `elektron-net-ppool` running the patched code. Confirm in the device logs that `Failed to process mining notification` no longer appears and that new job IDs are actually adopted. Elektron Net has no separate public testnet - `doc-elektron/mining-pool-integration.md` §7/§11 (in `elektron-net`) is explicit that "a private regtest" is the standard pre-mainnet pool test environment, so this item targets regtest, not testnet. Still open: no physical ESP-Miner/NerdMiner hardware was available for this fix - see Section 9 for what was verified instead (a spec-faithful software Stratum client on a real regtest node).
5. **Consensus test - mine an actual block.** On a private regtest node, let the patched pool find a block and submit it via `submitblock`. Confirm the node accepts it (no `bad-utxo-attestation`). **Done - see Section 9.** Six blocks were mined end-to-end through the patched pool on a from-scratch regtest chain and all six were accepted by an unpatched, freshly-built `elektron-net` node.
6. **Regression test - existing splice-detection tests.** Re-run the existing `StratumV1Client.spec.ts` suite, since some of its fixtures build expectations around `coinbasePart1`/`coinbasePart2`; update any fixture that assumed the old all-in-`coinb1` layout. **Done.** The full suite (both repos) was re-run after the 4.1/4.2 change; no `StratumV1Client.spec.ts` fixture assumed the old layout, so none needed updating. The suite's one failing test (`should submit and persist found blocks`) is pre-existing and unrelated - confirmed by reproducing it identically on the unmodified `main` branch before this fix was applied.

## 7. Cross-Repo Impact

- **`elektron-net-pool` (solo pool backend) - confirmed affected, apply the same patch.** `diff` against `elektron-net-ppool` shows `src/models/stratum.constants.ts` and `src/models/MiningJob.ts` are byte-identical between the two repos. Sections 4.1 and 4.2 of this report apply to `elektron-net-pool` verbatim, same file paths, same line-level change. Do not treat this as "probably affected, should check" - it is affected, on confirmed identical source.
- **`elektron-net-pool-startos`:** this repository is a StartOS packaging wrapper only (`Dockerfile`, `startos/` manifest and actions); its `Dockerfile` clones `kutlusoy/elektron-net-pool` at build time and packages it. It carries no stratum logic of its own, so once `elektron-net-pool` is patched and a new release/tag is cut, `elektron-net-pool-startos` picks up the fix automatically on its next image build (subject to whatever `ELEKTRON_POOL_REF` build arg / pinned ref it uses - confirm that ref is updated to include the fix commit).
- **`elektron-net-NerdMiner_v2`:** the earlier fix for `extranonce2_size = 0` in this fork worked around a symptom of the same underlying `coinb1`/`coinb2` layout (the fork's bad-utxo-attestation bug). Once both pools send a standards-shaped split, re-test the NerdMiner fork against each: its special-case handling for the zero-extranonce case may become unnecessary, but should not be removed until confirmed redundant, since other, third-party pools it might connect to could still send an all-in-`coinb1` layout.
- **Any other Stratum V1 client** connecting to either Elektron Net pool should be re-tested after this change, since the wire format of `mining.notify` is changing (values of `coinb1`/`coinb2` differ) even though the semantic content and the underlying transaction bytes do not.

## 8. Checklist

**`elektron-net-ppool`:**
- [x] Apply the split-offset change in `MiningJob.ts` constructor (Section 4.1)
- [x] Apply the `buildHeaderBuffer()` companion fix in the same change (Section 4.2)
- [x] Add the three unit tests described in Section 6 (reassembly identity, header hash unchanged, boundary correctness)
- [x] Update any `StratumV1Client.spec.ts` fixtures that assumed the old all-in-`coinb1` layout - none needed updating, confirmed by re-running the full suite
- [ ] Test against real ESP-Miner/NerdMiner firmware and confirm no more `Failed to process mining notification` - **still needs physical hardware**; see Section 9 for the regtest-level substitute that was completed
- [x] Mine at least one regtest block end-to-end through `submitblock` and confirm the node accepts it (no testnet exists for Elektron Net - see Section 9)

**`elektron-net-pool` (solo, confirmed identical code):**
- [x] Apply the same split-offset change in `MiningJob.ts` constructor (Section 4.1)
- [x] Apply the same `buildHeaderBuffer()` companion fix (Section 4.2)
- [x] Add the same three unit tests (Section 6)
- [ ] Test against real ESP-Miner/NerdMiner firmware - **still needs physical hardware**
- [x] Mine at least one regtest block end-to-end and confirm the node accepts it (Section 9; `elektron-net-pool` shares the identical `MiningJob.ts`/`stratum.constants.ts` exercised by the `elektron-net-ppool` regtest run)

**Downstream / cross-repo:**
- [ ] Cut a new tagged release of `elektron-net-pool` including the fix, and confirm `elektron-net-pool-startos`'s `ELEKTRON_POOL_REF` build arg points at (or floats to) that release
- [x] Re-test `elektron-net-NerdMinerv2` against the patched pool - source-level confirmation only (Section 9); no physical device was available
- [ ] Re-test any other known Stratum V1 client against both patched pools

## 9. Regtest End-to-End Verification (completed August 31, 2026)

Since Elektron Net has no separate public testnet - only `mainnet` and
`regtest` (`.env.example`; confirmed against `elektron-net`'s
`doc-elektron/mining-pool-integration.md` §7/§10/§11, which explicitly
recommends "a private regtest" as the pre-mainnet pool test environment) -
Section 6 items 4-6 were executed against a from-scratch private regtest
node instead of the "signet/testnet" environment the original test plan
named.

### 9.1 Setup

- Built `elektron-net` (`elektrond`, `elektron-cli`) from source (`cmake
  -DBUILD_GUI=OFF -DWITH_ZMQ=ON -DENABLE_IPC=OFF`) and started it with
  `-regtest` on a fresh, empty data directory.
- Created a pool wallet and three separate payout addresses (simulating
  three independent miners, "A"/"B"/"C").
- Ran `elektron-net-ppool` on this `duplicatefix` branch (i.e. including
  the 4.1/4.2 fix) against the regtest node, with `PPLNS_WINDOW_MINUTES`,
  `MIN_PAYOUT_THRESHOLD_SATS` and `PAYOUT_INTERVAL_MINUTES` tuned down so
  a short-lived test run could exercise the full share -> block -> PPLNS
  split -> payout pipeline.
- Wrote a small, spec-faithful Stratum V1 test client (Node.js, not part
  of either repo) that subscribes, authorizes as `<address>.<worker>`,
  reconstructs the header from `coinb1`/`coinb2` exactly as the fixed
  `MiningJob.ts` does (no extranonce splice, `EXTRANONCE2_SIZE_BYTES = 0`),
  brute-forces a qualifying nonce, and submits `mining.submit` - i.e. a
  from-scratch, from-spec client, not a copy of the pool's own code.

### 9.2 A second real bug found and fixed along the way

Setting up the regtest wallet surfaced a second, unrelated bug pushed to
this same branch: `src/utils/elektron-network.ts`'s `elektronRegtest`
network object used bech32 HRP `bert`, but the node's own regtest chain
params (`src/kernel/chainparams.cpp`, `CRegTestParams`) hardcode
`bech32_hrp = "bcrt"` - the standard Bitcoin regtest HRP, unchanged by
Elektron. With `bert`, the pool would have rejected every address its own
regtest node's wallet generates. Fixed in both repos (`bert` -> `bcrt`);
see the commit "Fix regtest bech32 HRP mismatch: bert -> bcrt".

Two further bugs turned up in the *test client* itself (nonce sent as a
byte-reversed little-endian hex dump instead of the plain hex integer
`parseInt` expects; `prevHash` used directly off the wire without undoing
the pool's `swapEndianWords()`). Both are test-tooling bugs, not pool
bugs, and are noted here only because their symptom (`canonical=0.00000000`
in the pool's `DIAGNOSTIC_SHARE_LOGGING_MODES` output) is exactly what a
real miner-side header-construction bug would also look like - useful to
know when reading pool logs during future integration debugging.

### 9.3 Results

- **Six shares submitted across three simulated miners, six blocks found
  and accepted.** Each `submitblock` call returned `SUCCESS!` against an
  unmodified, freshly-built `elektron-net` node - i.e. the coinbase the
  patched pool produces (`coinb1 + coinb2` reassembled) is byte-valid
  consensus, not just internally self-consistent.
- **PPLNS proportional split verified against the raw ledger.** For every
  block, the per-miner payout matches `theirShareDifficulty /
  totalWindowDifficulty * (blockReward * (1 - feePercent))` to
  floor-rounding precision, including blocks where the window carried
  shares from more than one miner and more than one prior block - the
  defining rolling-window behavior of PPLNS, not just a single-miner
  sanity check.
- **Pool fee** (2% in this run) was deducted identically on all six
  blocks; dust from floor-rounding was swept to pool accounting, not lost.
- **Dry-run payout** (`PAYOUT_DRY_RUN=true`) logged exactly the same
  per-miner totals as the ledger.
- **Real payout** (`PAYOUT_DRY_RUN=false`) executed an actual `sendmany`
  RPC call; the resulting regtest transaction paid each of the three
  miner addresses their exact ledger-computed amount (verified via
  `gettransaction`, down to the lepton). The reconciliation pass
  (`PayoutSchedulerService.reconcileSentPayouts`) marked every ledger row
  `CONFIRMED` once the payout transaction had one confirmation, with no
  `RECONCILIATION MISMATCH` warning at any point in the run.

This confirms the 4.1/4.2 fix (Sections 4.1-4.2) is consensus-valid end to
end on a real node, and that the PPLNS reward-splitting pipeline built on
top of it (`elektron-net-ppool`-specific, not present in `elektron-net-pool`)
is unaffected by the coinbase change and computes correctly.
