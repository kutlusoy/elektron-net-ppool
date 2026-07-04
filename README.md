## Description

A NestJS and TypeScript Stratum V1 mining pool server for **Elektron Net**
(a Bitcoin Core C++20 fork with mandatory pruning, per-block UTXO attestation
and 60 s block time — see `doc-elektron/BITCOIN_CORE_DIFF.md` and
`doc-elektron/mining-pool-integration.md` in the elektron-net repo).

This is the **PPLNS (Pay Per Last N Shares) shared-mining pool**. It is a
sibling of [`elektron-net-pool`](https://github.com/kutlusoy/elektron-net-pool)
(the solo pool, unmodified, still 100% payout to whoever finds the block) and
shares its entire attestation-compatible codebase. The only functional
difference from the solo pool is *who* the coinbase pays and how that reward
is subsequently split:

- Every connected miner's coinbase pays the pool's own `POOL_WALLET_ADDRESS`,
  not the miner's address (see `src/models/StratumV1Client.ts`,
  `getPoolWalletAddress()`).
- Every valid share is logged in a dedicated PPLNS ledger
  (`PplnsShareLogService`) independent of the existing hashrate/vardiff
  statistics.
- When a block is found, `RewardCalculatorService` splits the actual
  coinbase value (subsidy + fees) proportionally among everyone who
  submitted shares within the last `PPLNS_WINDOW_MINUTES`, minus
  `POOL_FEE_PERCENT`, and credits each miner's balance in
  `PayoutLedgerService`.
- `PayoutSchedulerService` batches up miner balances above
  `MIN_PAYOUT_THRESHOLD_SATS` into a periodic `sendmany`-style payout
  transaction, and reconciles sent transactions against confirmations and
  the pool wallet's on-chain balance.
- The UI is served by the sibling
  [`elektron-net-ppool-ui`](https://github.com/kutlusoy/elektron-net-ppool-ui)
  repo, itself a fork of `elektron-net-pool-ui` with PPLNS-specific views
  added (pending balance, payout history, PPLNS window stats, fee
  disclosure).

The upstream Elektron-specific attestation handling (shared with the solo
pool) is unchanged:

- Reads `coinbase_required_outputs` from `getblocktemplate` and appends them
  verbatim to the coinbase (UTXO attestation + witness commitment, in that
  order).
- Honours `coinbase_script_sig_prefix` when supplied by the node.
- Accepts Bech32 addresses with the Elektron HRP `be` (`be1q…`) via
  `bitcoinjs.address.toOutputScript`.
- Sets coinbase `nLockTime = height - 1` as required by consensus.
- **Per-miner block templates.** The Elektron node computes the UTXO
  attestation hash against the template's coinbase, including the payout
  output. The pool therefore calls `getblocktemplate` separately for each
  connected miner, passing `POOL_WALLET_ADDRESS` in the `coinbaseaddress`
  parameter (all miners get the identical template, since they all pay the
  same address — see "Follow-up optimizations" below). Each client refreshes
  its template on every new block plus a 30 s safety timer.
- **No on-chain fee split in the coinbase.** A second coinbase output would
  change the bytes the attestation hash was computed against, so the pool
  fee is deducted purely by accounting during the PPLNS payout — never as
  an additional coinbase output.

Requires an **Elektron Net node v4.0+** (protocol version 70017) as the RPC
backend.

### Follow-up optimizations (not yet implemented)

Since all miners share the same `POOL_WALLET_ADDRESS`, their coinbase is
byte-identical. A future optimization could fetch one shared
`getblocktemplate` for all connected workers instead of one call per miner,
substantially reducing RPC load on the node. Not required for this version.

## Installation

```bash
$ npm install
```

Create a new `.env` file in the root directory and configure it with the
parameters in `.env.example`.

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production build
$ npm run build
```

## Test

```bash
# unit tests
$ npm run test

# test coverage
$ npm run test:cov
```

## PPLNS configuration

See `.env.example` for the full list of PPLNS-specific variables
(`POOL_WALLET_ADDRESS`, `PPLNS_WINDOW_MINUTES`, `POOL_FEE_PERCENT`,
`MIN_PAYOUT_THRESHOLD_SATS`, `PAYOUT_INTERVAL_MINUTES`,
`PAYOUT_CONFIRMATIONS_REQUIRED`, `PAYOUT_DRY_RUN`, `WALLET_RPC_*`).
`POOL_WALLET_ADDRESS` is required — the pool refuses to build mining jobs
without it.

`WALLET_RPC_*` defaults to the same connection as `ELEKTRON_RPC_*` (single
server, fine for testnet/development). For mainnet operation, point it at a
separate, network-isolated wallet server instead — see the concept doc §9
for the recommended topology (VPN-tunnelled wallet RPC, pruned pool node,
unpruned wallet node). This is a configuration change only, no code change
needed.

Before your first live payout, run with `PAYOUT_DRY_RUN=true` and confirm
the logged payout batches look correct — the scheduler will log what it
would pay without calling `sendmany` or touching the payout ledger.

### New read-only API endpoints

In addition to the existing `elektron-net-pool` endpoints, this pool exposes:

```
GET /api/miner/:address/pending-balance
GET /api/miner/:address/payout-history
GET /api/pool/pplns-window-stats
GET /api/pool/fee-info
```

These back the PPLNS-specific views in `elektron-net-ppool-ui`.

## Web interface

See [elektron-net-ppool-ui](https://github.com/kutlusoy/elektron-net-ppool-ui)
(a fork of [elektron-net-pool-ui](https://github.com/kutlusoy/elektron-net-pool-ui)
with PPLNS-specific views added).

## Supported miners

See [`Miner_Compatibility_List.md`](./Miner_Compatibility_List.md) for the
full matrix of tested SHA-256d miners (industrial ASICs, hobby ASICs,
CPU/GPU clients) with per-miner status and the reason behind any
incompatibility. Short version: anything running stock cgminer-derived
firmware — Antminer, Whatsminer, Avalon, Canaan, Innosilicon, Bitaxe
(ESP-Miner), cpuminer, bfgminer, sgminer — works in NORMAL mode out of
the box. NerdMiner_v2 and its forks (NerdAxe, NerdQAxe) stay connected
in HOBBY mode but cannot earn rewards: their firmware hardcodes a
coinbase extranonce splice that Elektron's per-block UTXO attestation
rejects.

## Deployment

Install pm2 (https://pm2.keymetrics.io/)

```bash
$ pm2 start dist/main.js
```

When running the worker app in PM2 cluster mode, start the PM2 daemon with OS-level
connection scheduling. The environment variable must be present when the PM2 daemon
starts, not only in the worker configuration.

```bash
$ NODE_CLUSTER_SCHED_POLICY=none pm2 start ecosystem.config.js
```

Cluster-mode connection dropping requires Node.js `22.12.0` or newer.

### Sizing for Elektron Net

Because each connected miner triggers its own `getblocktemplate` call on the
Elektron node (per new block + every 30 s), the practical connection ceiling
is bound by your node's RPC throughput, **not** raw socket capacity. The
`STRATUM_MAX_CONNECTIONS_PER_LISTENER` cap (default `10000`) is enforced per
worker and Stratum port, but you should set it well below that to match
your node — start with `50`–`100` and scale once you've measured RPC load.
The built-in backpressure monitor (`STRATUM_BACKPRESSURE_*`) also pauses
accepts when the event loop or RSS goes red.

## Docker

Build container:

```bash
$ docker build -t elektron-pool .
```

Run container:

```bash
$ docker container run --name elektron-pool --rm -p 3333:3333 -p 3334:3334 -p 8332:8332 -v .env:/elektron-pool/.env elektron-pool
```

### Docker Compose

Build container:
```bash
$ docker compose build
```

Run container:
```bash
$ docker compose up -d
```

The docker-compose binds to `127.0.0.1` by default. To expose the Stratum services on your server change:
```diff
    ports:
-      - "127.0.0.1:3333:3333/tcp"
-      - "127.0.0.1:3334:3334/tcp"
+      - "3333"
+      - "3334"
```

**note**: To successfully connect to the Elektron RPC you will need to add

```
rpcallowip=172.16.0.0/12
```

to your `elektron.conf`.

## Migrating from a Bitcoin pool

The `ELEKTRON_RPC_*` env vars are preferred; the legacy `BITCOIN_RPC_*` names
still work as a fallback to ease migration. See `.env.example` for the full
list.

The `NETWORK` setting defaults to `mainnet` (Elektron mainnet, HRP `be`). For
testing against an upstream Bitcoin Core node, set `NETWORK=bitcoin-mainnet`,
`bitcoin-testnet` or `bitcoin-regtest`.

`DEV_FEE_ADDRESS` from upstream `public-pool` is ignored: Elektron's per-block
UTXO attestation pins the coinbase to a single payout output, so the pool
cannot insert a fee split. This is also why the pool fee here
(`POOL_FEE_PERCENT`) is deducted by accounting during the PPLNS payout
instead of as a second coinbase output.

## Verification before going live

Attestation compatibility is inherited unchanged from the solo pool and is
already battle-tested, but the PPLNS reward/payout path is new. Before the
first mainnet block:

1. Run against a testnet/regtest Elektron node and submit a test block —
   confirm the node accepts it (no `bad-utxo-attestation`).
2. Feed the PPLNS share log synthetic data with known difficulty values and
   manually verify `RewardCalculatorService`'s split.
3. Run `PayoutSchedulerService` with `PAYOUT_DRY_RUN=true` first and
   manually verify the logged amounts before enabling real `sendmany` calls.
4. Confirm the wallet-balance reconciliation check
   (`PayoutSchedulerService.checkPoolWalletReconciliation`) logs cleanly
   with no mismatch warnings under normal operation.
