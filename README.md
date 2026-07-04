## Description

A NestJS and TypeScript Stratum V1 mining pool server for **Elektron Net**
(a Bitcoin Core C++20 fork with mandatory pruning, per-block UTXO attestation
and 60 s block time — see `doc-elektron/BITCOIN_CORE_DIFF.md` and
`doc-elektron/mining-pool-integration.md` in the elektron-net repo).

This fork derives from `public-pool`. The Elektron-specific changes are:

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
  connected miner, passing the miner's payout address in the
  `coinbaseaddress` parameter. Templates cannot be shared across miners as
  in plain Bitcoin pools — a mismatch would be rejected as
  `bad-utxo-attestation`. Each client refreshes its template on every new
  block plus a 30 s safety timer.
- **No dev/pool fee in the coinbase.** A second coinbase output would
  change the bytes the attestation hash was computed against, so 100 % of
  the block reward goes directly to the miner's authorized payout address.

Requires an **Elektron Net node v4.0+** (protocol version 70017) as the RPC
backend.

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

## Web interface

See [elektron-net-pool-ui](https://github.com/kutlusoy/elektron-net-pool-ui).

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
cannot insert a fee split. Operators who want to charge fees must collect
them off-chain (e.g. periodic transfers from miner addresses).
