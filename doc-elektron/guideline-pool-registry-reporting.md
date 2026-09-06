# Elektron Net - `elektron-net-ppool` Pool Registry Reporting Guideline

- **Version:** 0.1 (planning, nothing implemented yet)
- **Date:** September 6, 2026
- **Audience:** `elektron-net-ppool` developers, PPLNS pool operators
- **Reference implementation:** `src/controllers/pplns/pplns.controller.ts` (the existing `GET /pool/identity` endpoint this extends)
- **See also:** [`fix-report-pool-identity-utxo-attestation.md`](./fix-report-pool-identity-utxo-attestation.md) (why the on-chain approach this replaces was reverted), the identical planning document in `elektron-net-pool` (this document mirrors it byte for byte apart from repo-specific paths), `elektron-net-mempool`'s `doc-elektron/guideline-pool-registry-reporting.md` (the consumer side)

- Never use the em dash character in this document or its follow-up code comments; use a hyphen and spaces instead, as done throughout.

---

## 1. Problem This Solves

Same as `elektron-net-pool`'s document: the reverted on-chain pool-identity feature broke UTXO attestation. Its replacement must not touch consensus, must cost nothing, and must work identically for solo pool (no wallet, coinbase pays the finding miner directly) and PPLNS pool (has a wallet), which rules out anything keyed on wallet ownership or coinbase content.

## 2. Design Overview

A new repository, `github.com/kutlusoy/elektron-net-registry` (not created yet), holds two plain text files extended purely by fork + pull request:

- `pools.txt`: one line per pool (both `ppool` and solo `pool`), format `"Name"; "URL";`
- `mempools.txt`: one line per known block-explorer instance, same format

This repo consumes `mempools.txt` via a single configured registry URL (mirrors the polling/SHA-diffing pattern `elektron-net-mempool`'s `pools-updater.ts` already uses for `pools-v2.json`, generalized so one URL is enough).

Reporting flow:

1. This pool finds a block (already known the moment `submitblock` succeeds).
2. It looks up its locally-synced copy of `mempools.txt` and sends every known mempool instance a small report: `POOL_IDENTIFIER` and the found block's hash.
3. A receiving mempool does not trust the report directly. It looks up the claimed name in its own copy of `pools.txt` to get this pool's registered URL, then calls back asking "did you report block `<hash>`?".
4. This repo must answer that callback honestly and only for blocks it actually just found - see Section 3.

This binds trust to control of the registered URL, not to a wallet or on-chain data, so it works the same way for this repo and `elektron-net-pool` alike.

## 3. What Changes in This Repo

- **New updater task**: fetches `mempools.txt` from the registry, keeps a synced list of known explorer instances to report to.
- **On block found**: loop over the synced `mempools.txt` list and send each a report (`POOL_IDENTIFIER`, block hash).
- **New confirmation endpoint**, alongside the existing `GET /pool/identity`: accepts a block hash and answers whether this pool itself reported that exact block recently. Backed by a short-lived, in-memory record of recently-submitted block hashes (a small ring buffer or TTL map is enough; no database table needed). The exact path and payload shape must match what `elektron-net-mempool` expects, to be settled jointly before implementation.

## 4. Open Questions

1. Exact endpoint paths/payload shapes, to be agreed with `elektron-net-mempool` and kept identical to `elektron-net-pool`'s implementation.
2. How long "recently found" needs to be remembered (must comfortably cover the slowest mempool's poll interval plus retries).
3. Registry poll interval for `mempools.txt` on this side (should match whatever `elektron-net-mempool`'s document settles on for its own `pools.txt` poll, for consistency).
4. Retry behavior if a listed mempool instance's report endpoint is temporarily unreachable.

## 5. Checklist

- [ ] `elektron-net-registry` repository created with `pools.txt` / `mempools.txt`
- [ ] Registry updater task implemented (mirrors `pools-updater.ts` from `elektron-net-mempool`)
- [ ] Report-on-block-found implemented
- [ ] Confirmation endpoint implemented
- [ ] Open questions above resolved and reflected here before implementation begins
- [ ] Verified byte-identical behavior with `elektron-net-pool`'s implementation
