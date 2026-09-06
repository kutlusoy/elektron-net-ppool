# Elektron Net - `elektron-net-ppool` Pool Registry Reporting Guideline

- **Version:** 0.2 (implemented on `reporegistry`, pending review/merge and live testing before `main`)
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

## 3. What Changed in This Repo

- **`src/services/pool-registry.service.ts`** (new): fetches `mempools.txt` from `${MEMPOOL_REGISTRY_URL}/mempools.txt` every 15 minutes (`@Interval`, plus once on module init), parses `"Name"; "URL";` lines (malformed lines skipped), and keeps the result in memory. Also owns a TTL map of recently-found block hashes (30-minute window, comfortably longer than any mempool should ever take to receive a report and call back).
- **`reportBlockFound(blockHash)`**: records the hash locally, then POSTs `{ name: POOL_IDENTIFIER, blockHash }` to `<mempoolUrl>/api/v1/pool-registry/report` for every known mempool instance in parallel, 5-second timeout each, failures logged and otherwise ignored (best-effort, nothing else depends on it). Called from `StratumV1Client.ts` right after a found block is saved and notified, using the submitted block's real id (`updatedJobBlock.getId()`).
- **`GET /pool/identity/confirm?blockHash=<hex>`** (new, `pplns.controller.ts`, alongside the existing `GET /pool/identity`): returns `{ confirmed, name, url }`, where `confirmed` is true only if this pool itself recorded finding that exact block hash recently.
- **`MEMPOOL_REGISTRY_URL`** (new env var, `.env.example`, commented out/optional): base URL of the registry repo (raw content, no trailing slash). The default (`https://raw.githubusercontent.com/kutlusoy/elektron-net-registry/main`) is baked into `pool-registry.service.ts` itself, not just the `.env.example` comment, so an existing deployment that upgrades without touching its `.env` at all still works - the variable only ever overrides that default, it does not gate the feature.
- **Local cache**: the last successfully fetched `mempools.txt` is written to `./DB/mempools-registry.txt` (same persisted volume as the sqlite DB). On startup this file is read first, before any network attempt, so the pool has a usable mempool list immediately even if the registry host is unreachable at boot. A failed or empty-parsing fetch never overwrites the in-memory list or the cache file - it just leaves both as they were.

## 4. Decisions Made

1. Report endpoint: `POST /api/v1/pool-registry/report`, body `{ name, blockHash }` (mempool side). Confirm endpoint: `GET /pool/identity/confirm?blockHash=<hex>` (this side), response `{ confirmed, name, url }`. Identical in `elektron-net-pool`.
2. Recently-found window: 30 minutes.
3. Registry poll interval: 15 minutes, both sides.
4. Retry behavior: none. A report is fire-and-forget with a 5-second timeout; an unreachable mempool just never gets that block attributed, no queue or retry.

## 5. Checklist

- [x] `elektron-net-registry` repository created with `pools.txt` / `mempools.txt`
- [x] Registry updater task implemented (`pool-registry.service.ts`, simplified vs. `pools-updater.ts`: plain refetch on each poll rather than SHA-diffing, since these files are tiny)
- [x] Report-on-block-found implemented
- [x] Confirmation endpoint implemented
- [x] Verified byte-identical behavior with `elektron-net-pool`'s implementation
- [ ] Live-test on regtest/testnet (real found block, real report, real callback) before merging to `main`
