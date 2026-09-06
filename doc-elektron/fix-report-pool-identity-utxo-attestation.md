# Elektron Net - `elektron-net-ppool` Fix Report: Pool Identity Outputs Broke UTXO Attestation

- **Version:** 1.0
- **Date:** September 6, 2026
- **Audience:** `elektron-net-ppool` developers, PPLNS pool operators
- **Reference implementation:** [`elektron-net`](https://github.com/kutlusoy/elektron-net) - `src/validation.cpp` (`ComputeBlockUTXOAttestationHash()`, `ValidateUTXOCheckpoint()`), `src/node/miner.cpp` (`CreateNewBlock()`), `doc-elektron/mining-pool-integration.md` Section 5.6 - treat as ground truth for anything referenced below
- **See also:** [`elektron-net-pool`'s fix-report-pool-identity-utxo-attestation.md](https://github.com/kutlusoy/elektron-net-pool/blob/main/doc-elektron/fix-report-pool-identity-utxo-attestation.md) (the sibling document for the solo pool, which had the identical bug and originated this feature), [`elektron-net-mempool`'s fix-report-pool-identity-utxo-attestation.md](https://github.com/kutlusoy/elektron-net-mempool/blob/main/doc-elektron/fix-report-pool-identity-utxo-attestation.md) (the consumer-side revert)

- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. What Happened

The previously merged `guideline-pool-identity-op-return.md` added two informational, zero-value `OP_RETURN` outputs to the coinbase (`POOL_IDENTIFIER` as `EPNM`, `POOL_URL` as `EPUR`), appended after the required outputs. On a live deployment with `POOL_IDENTIFIER` set (the shipped `.env.example` default, `"Elektron-PPLNS-Pool"`, is non-empty), every block this pool found was rejected by the network with `bad-utxo-attestation`.

This document explains why, and records that the fix is a full revert of the on-chain outputs, not a smaller patch, because the underlying constraint cannot be satisfied from the pool side at all.

## 2. Root Cause

`elektron-net`'s `doc-elektron/mining-pool-integration.md`, Section 5.6, already stated this constraint explicitly:

> No dev fee / pool fee in the coinbase. Elektron's attestation pins the coinbase to a single payout output and any output split would invalidate the template's attestation.

The `guideline-pool-identity-op-return.md` design only checked that the new outputs could not be mistaken for the UTXO attestation shape (two data pushes: height + 32-byte hash) or the witness-commitment shape (single 36-byte push starting with `aa21a9ed`). It did not account for the actual mechanism: `ComputeBlockUTXOAttestationHash()` keys the payout's UTXO entry by `COutPoint(coinbase.GetHash(), 0)`. The coinbase's txid changes the instant **any** output is added, removed, or reordered, regardless of that output's shape or value. The node computes the embedded attestation hash at template time against a coinbase containing only the payout output plus `coinbase_required_outputs`. Any block whose submitted coinbase has additional outputs - EPNM/EPUR included - necessarily has a different txid, so `ValidateUTXOCheckpoint()`'s recomputed hash never matches the one embedded in the template, and the block is rejected every time. This is not intermittent and not related to template staleness; it happens on every single block once either `POOL_IDENTIFIER` or `POOL_URL` is non-empty.

## 3. Why This Cannot Be Fixed From the Pool Side

There is no coinbase output, of any shape, size, or position, that a pool can add to a valid Elektron Net block without invalidating its own attestation, short of a node-side consensus change to how `ComputeBlockUTXOAttestationHash()` keys the payout coin (e.g. computing over a canonical/stripped coinbase that ignores non-attestation, non-witness-commitment outputs). Such a change was explicitly ruled out for this fix - it is a consensus rule affecting every full node on the network, not a pool-side patch, and is out of scope here.

## 4. Fix Applied

- Removed `appendPoolIdentityOutputs()` / `appendPoolIdentityOutput()` / `sanitizePoolIdentityText()` and the `POOL_IDENTITY_MAGIC_NAME` / `POOL_IDENTITY_MAGIC_URL` / `POOL_IDENTITY_MAX_TEXT_BYTES` constants from `src/models/MiningJob.ts`. The coinbase is built exactly as `mining-pool-integration.md` Section 3.1 specifies again: `vout[0]` payout, `vout[1..N]` required outputs, nothing else.
- Removed the corresponding test cases from `src/models/MiningJob.spec.ts`.
- Removed `doc-elektron/guideline-pool-identity-op-return.md` (the design that introduced this).
- **Kept** the `GET /pool/identity` HTTP endpoint (`src/controllers/pplns/pplns.controller.ts`) and the `POOL_IDENTIFIER` / `POOL_URL` config values themselves. This endpoint is off-chain only (it serves the pool's own dashboard, `elektron-net-ppool-ui`) and has no coinbase interaction, so it carries none of the attestation risk. Updated `.env.example`'s comments to state clearly that both values are off-chain only and explain why they cannot be embedded on-chain without a node consensus change.
- Block explorer attribution (`elektron-net-mempool`) falls back to its pre-existing address-based pool matching (`pools-parser.ts` / `matchBlockMiner()`); see that repo's own fix-report for the corresponding revert of its coinbase-scanning detector.

## 5. Checklist

- [x] Remove on-chain pool-identity output construction from `MiningJob.ts`
- [x] Remove associated test cases
- [x] Remove the now-incorrect guideline document
- [x] Clarify `.env.example` that `POOL_IDENTIFIER` / `POOL_URL` are off-chain only
- [x] Confirm `GET /pool/identity` endpoint is unaffected (off-chain, no coinbase interaction)

## 6. Open Questions

1. Whether an off-chain pool registry (name/URL keyed by known payout addresses, resolved via each pool's `GET /pool/identity` endpoint) is worth building for `elektron-net-mempool` to recover the structured-name/URL benefit the on-chain approach aimed for, without touching consensus. Not started; would need a design document of its own if pursued.
