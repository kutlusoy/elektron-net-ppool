# Elektron Net - `elektron-net-ppool` Pool Identity OP_RETURN Guideline

- **Version:** 0.2 (implemented on `poolidentity`, pending review/merge and live testing before `main`)
- **Date:** August 27, 2026
- **Audience:** `elektron-net-ppool` / `elektron-net-pool` developers, mining pool operators
- **Reference implementation:** [`elektron-net`](https://github.com/kutlusoy/elektron-net) - `doc-elektron/guideline-coinbase-third-op-return.md` (the decided design this document extends), `src/validation.cpp` (`ExtractCoinbaseUTXOAttestation()`), `src/consensus/validation.h` (`GetWitnessCommitmentIndex()`) - treat as ground truth for anything referenced below
- **Consumer:** [`elektron-net-mempool`](https://github.com/kutlusoy/elektron-net-mempool) - `backend/src/api/blocks.ts`, `backend/src/api/pools-parser.ts` (detection/display side, specified in the companion document `doc-elektron/guideline-pool-identity-detection.md` in that repo)
- **See also:** [`guideline-coinbase-third-op-return.md`](https://github.com/kutlusoy/elektron-net/blob/main/doc-elektron/guideline-coinbase-third-op-return.md), [`mining-pool-integration.md`](https://github.com/kutlusoy/elektron-net/blob/main/doc-elektron/mining-pool-integration.md)

- Requirement-level words follow standard usage: **MUST** = mandatory, **SHOULD** = strongly recommended, **MAY** = optional.
- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Status of This Document

This is a **plan, not yet implemented**. It specifies the concrete `elektron-net-ppool` implementation of the pool-side coinbase output that `elektron-net`'s `doc-elektron/guideline-coinbase-third-op-return.md` (v1.0, Section 5) already decided is safe to add without a consensus change, extended per an explicit follow-up decision (August 27, 2026) to use **two** separate, magic-tagged outputs (pool name, pool URL) instead of the single free-form-text output originally described. Section 8 below calls out exactly how this differs from the v1.0 text and why the difference does not reopen the "no consensus change" conclusion.

**Implemented** on the `poolidentity` branch (`MiningJob.ts`, `.env.example`, `MiningJob.spec.ts`), not yet merged to `main` - Ali is running it through further live testing before merging himself. See Section 9 for what remains.

## 2. Why: Limits of Today's Address-Based Pool Identification

Today, a PPLNS pool is identified by block explorers purely by which payout address ends up in the coinbase (`elektron-net-mempool`'s `pools-parser.ts`, `matchBlockMiner(scriptsig, addresses, pools)`, matching against a curated `pools.json`-derived registry of `addresses`/`regexes`). `MiningJob.ts` in this repo builds exactly one spendable payout output (`vout[0]`, see `createCoinbaseTransaction()`), which is the only thing that address-matching can key on.

This has three concrete problems:

1. **Address rotation breaks identification.** If `POOL_WALLET_ADDRESS` changes (key rotation, migrating to a new wallet server per the `WALLET_RPC_*` scenario in `.env.example`), every block mined afterwards is unmatched until someone manually updates the external `pools.json` registry. The pool's on-chain identity is tied to an operational/financial detail that has no reason to stay stable forever.
2. **No structured field for a URL.** The existing registry can carry a link, but only because a human curator added it out of band; the pool itself cannot assert its own URL on-chain.
3. **Conflates payment with identity.** The one thing a pool operator actually wants to control ("who mined this, and where can I learn more") is entangled with the one thing that must not casually change (where the money goes).

## 3. Decided Constraint (Inherited, Must Not Be Violated)

`elektron-net`'s `guideline-coinbase-third-op-return.md` already established, and this document does not revisit, the following facts about how the two existing coinbase `OP_RETURN` outputs are located at validation time:

- **UTXO attestation** - `ExtractCoinbaseUTXOAttestation()` (`src/validation.cpp:2423-2459`) scans `vout` and returns on the **first** output whose `OP_RETURN` payload decodes as **two consecutive data pushes**: a `CScriptNum`-like value equal to the current height, then an **exact 32-byte** push. No uniqueness check exists.
- **Witness commitment** - `GetWitnessCommitmentIndex()` (`src/consensus/validation.h:147-162`) scans `vout` and keeps the **last** output whose `OP_RETURN` payload is a **single 36-byte push** starting with the 4-byte magic `aa21a9ed` (i.e. the 6 bytes `OP_RETURN 0x24 0xaa 0x21 0xa9 0xed` at the start of the script).

Any new coinbase output this document adds **MUST** stay clear of both shapes:

- (a) **MUST NOT** ever be interpretable as two consecutive pushes of `<height-like value><exact 32 bytes>` - satisfied by construction if every new output is a **single** data push (see Section 4).
- (b) **MUST NOT** ever be interpretable as a single 36-byte push starting with `aa21a9ed` - satisfied by choosing magic prefixes that differ from `aa21a9ed` in their leading bytes (see Section 4), independent of push length.
- (c) **MUST** always be appended strictly after the existing `coinbase_required_outputs` loop (never inserted earlier), so the first-match attestation scan in (a) always finds the real attestation at `vout[1]` before it could ever reach these new outputs, exactly as `guideline-coinbase-third-op-return.md` Section 5.1 requires.

## 4. New Design: Two Magic-Tagged Outputs

Per Ali's direction, pool name and pool URL are **two separate coinbase outputs**, each carrying its own fixed 4-byte magic prefix (distinct from `aa21a9ed`), rather than one combined free-form string:

| Output | Content | Magic (hex) | Magic (ASCII) |
|---|---|---|---|
| `vout[3]` | Pool name | `45504e4d` | `EPNM` (Elektron Pool NaMe) |
| `vout[4]` | Pool URL | `45505552` | `EPUR` (Elektron Pool URl) |

Each output's script is `OP_RETURN <ONE data push>`, where the pushed bytes are `MAGIC (4 bytes) || UTF-8 payload`. Both outputs have `value = 0`.

Why this is safe against Section 3's two shapes:

- **Single push, not two** -> immediately fails `ExtractCoinbaseUTXOAttestation()`'s two-push shape check on the second `GetOp()` call, regardless of byte content (same reasoning `guideline-coinbase-third-op-return.md` Section 5.2 already relies on for the original single-output design).
- **Magic differs from `aa21a9ed` in its very first byte** (`0x45` vs `0x aa`, and `0x45` vs `0x aa` again for the second magic) -> can never be mistaken for the witness commitment regardless of total push length, so `GetWitnessCommitmentIndex()`'s last-match scan can only ever pick the real, node-generated commitment.
- **OP_RETURN outputs are never added to the UTXO set** (`IsUnspendable()`, unmodified) -> cannot affect the recomputed UTXO-set hash that `ValidateUTXOCheckpoint()` compares against, exactly as already established for the existing two outputs.

Both outputs **MUST** be appended after the existing `coinbase_required_outputs` loop / witness-commitment fallback branch, i.e. `vout[3]` and `vout[4]` are always the **last two** coinbase outputs on the pool's GBT path (Section 2 of `guideline-coinbase-third-op-return.md` describes this as the normal path for essentially all real hashrate).

Either output **MAY** be omitted independently (see Section 5) if its underlying config value is not set. When a value is omitted, no placeholder or zero-length output is produced for it - the coinbase looks exactly as it does today for anyone who does not opt in.

## 5. Config Surface

- **Pool name** reuses the existing `POOL_IDENTIFIER` environment variable (already present in `.env.example`, already used off-chain in `StratumV1Client.ts:845` for external share submission). This keeps a single source of truth instead of introducing a near-duplicate variable. Default remains `"Elektron-PPLNS-Pool"`.
- **Pool URL** is a **new** environment variable, `POOL_URL` (e.g. `https://elektron-net.org`), optional, unset by default. When unset, `vout[4]` is not produced.
- Both values **SHOULD** be capped at a conservative byte length (proposed default: 64 bytes of UTF-8 text per field, i.e. 68 bytes total per output including the 4-byte magic - comfortably under the common `OP_RETURN` relay-policy convention of ~80 bytes seen elsewhere in the Elektron Net stack, even though coinbase transactions are not subject to mempool relay-policy checks at all). Exact cap is an open question (Section 10).
- Both values **MUST** be sanitized before being pushed on-chain: strip bytes that do not form valid UTF-8, and truncate on a UTF-8 code-point boundary (never split a multi-byte sequence), following the same spirit as the existing `POOL_IDENTIFIER` doc comment ("it will be removed if it will make the block or coinbase script too big").

## 6. Exact Code Hook (`MiningJob.ts`)

The insertion point is immediately after the existing `requiredOutputs` / `witnessCommit` fallback block and before the `MAX_BLOCK_WEIGHT` check, i.e. right after the code that currently ends around:

```ts
} else if (jobTemplate.block.witnessCommit) {
    // ... existing witness-commitment fallback ...
}
```

and before:

```ts
if ((this.coinbaseTransaction.weight() + jobTemplate.block.weight()) > MAX_BLOCK_WEIGHT) {
```

Planned addition (illustrative, not yet implemented): a private method, e.g. `appendPoolIdentityOutputs(configService)`, called from the constructor at that exact point, that:

1. Reads `POOL_IDENTIFIER` and `POOL_URL` from `ConfigService`.
2. For each non-empty value: sanitizes and truncates it per Section 5, builds `bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([MAGIC, sanitizedTextBuffer])])`, and calls `this.coinbaseTransaction.addOutput(script, 0)`.
3. Skips the output entirely (no call to `addOutput`) when the corresponding config value is empty/unset.
4. Runs strictly after the existing `requiredOutputs` loop / witness-commitment fallback, and strictly before the weight check, so both new outputs are always counted in the existing `MAX_BLOCK_WEIGHT` guard with no separate check needed.

## 7. Test Plan

Extend `MiningJob.spec.ts` with cases that:

- Both `POOL_IDENTIFIER` and `POOL_URL` set -> exactly two new outputs appended, in order, as the **last** two outputs.
- Only one of the two set -> exactly one new output appended, the other absent.
- Neither set -> no change from today's coinbase shape (regression guard).
- Each new output decompiles (`bitcoinjs.script.decompile()`) to exactly `[OP_RETURN, <one Buffer>]` (single push, never two).
- Each new output's pushed bytes start with the expected magic (`45504e4d` / `45505552`).
- Neither new output's pushed bytes can ever form a 36-byte push starting with `aa21a9ed` (structural, by construction, but worth a regression assertion).
- `MAX_BLOCK_WEIGHT` check still fires correctly with the two extra outputs included in the weight calculation.
- Sanitization: a value containing invalid UTF-8 or exceeding the length cap is stripped/truncated on a code-point boundary before being pushed.

## 8. Delta From the Original v1.0 Decision

`elektron-net`'s `guideline-coinbase-third-op-return.md` v1.0 (Section 5) decided on **one** output, **free-form text**, explicitly **not** a fixed or versioned TLV format. This document's design differs in two ways:

1. **Two outputs instead of one** (name and URL as separate fields rather than one combined string).
2. **A fixed 4-byte magic prefix per output** (a minimal structural tag) rather than pure free-form text.

Both deltas remain attestation-safe and commitment-safe under exactly the same reasoning the v1.0 decision used (single push per output, always-last placement - Section 4 above walks through why). Nothing about the deltas requires revisiting the "no consensus rule change" conclusion. Ali may want to fold this addendum back into the `elektron-net` repo's decided-design document once this is implemented; that is out of scope for this branch and left as an open question (Section 10).

## 9. Checklist

- [x] Implement `appendPoolIdentityOutputs()` in `MiningJob.ts` per Section 6
- [x] Add `POOL_URL` to `.env.example`, documented next to the existing `POOL_IDENTIFIER` entry
- [x] Implement the sanitize/length-cap helper (Section 5)
- [x] Extend `MiningJob.spec.ts` per Section 7 (14/14 tests passing, including the pre-existing regression tests unmodified)
- [ ] Live-test on regtest/testnet (real `getblocktemplate`, real submitted block) before merging to `main` - Ali is doing this before merge
- [ ] Update `elektron-net`'s `mining-pool-integration.md` once merged, to document `vout[3]`/`vout[4]` as part of the coinbase layout
- [ ] Coordinate with the companion document in `elektron-net-mempool` (`doc-elektron/guideline-pool-identity-detection.md`) so the magic bytes match exactly - confirmed identical (`EPNM`/`EPUR`) as of this revision

## 10. Open Questions

1. Exact byte cap per field - Section 5 proposes 64 bytes of text each; needs confirmation.
2. Should `elektron-net-pool` (the solo pool) receive the identical feature for parity? Out of scope for this branch; noted here only.
3. Should `elektron-net`'s decided-design document be amended to record the two-output/magic-prefix delta from Section 8? Deferred.
4. Should the two magic values (`EPNM`/`EPUR`) be treated as part of the Elektron Net project's stable, cross-repo protocol (i.e. also used identically by `elektron-net-pool` and any future pool implementation), so that `elektron-net-mempool`'s detector works for every pool without per-pool special-casing? Recommendation: yes - see the companion mempool document.
