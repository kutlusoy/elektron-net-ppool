// 1:1 mirror of mining/miner.py:_build_coinbase_tx.
//
// The Python reference miner sets `scriptSig = bytes.fromhex(prefix_hex)`
// where `prefix_hex` is the `coinbase_script_sig_prefix` returned by
// `getblocktemplate`. Nothing else is appended — no extranonce padding,
// no pool identifier. The accompanying comment in miner.py is explicit:
//
//   # Use the exact prefix from getblocktemplate so UTXO attestation matches.
//
// Anything beyond the prefix changes the coinbase txid and the node
// rejects the block with `bad-utxo-attestation`. To stay byte-for-byte
// equivalent to the reference miner, the pool must therefore advertise
// zero extranonce on both sides:
//
//   * EXTRANONCE1_SIZE_BYTES = 0  → nothing is spliced by the pool
//   * EXTRANONCE2_SIZE_BYTES = 0  → nothing is iterated by the worker
//   * coinb1 = the full non-witness coinbase serialization
//   * coinb2 = "" (empty)
//
// With both sizes 0, `coinb1 + extranonce1 + extranonce2 + coinb2`
// degenerates to `coinb1` — exactly the bytes miner.py emits.
export const EXTRANONCE1_SIZE_BYTES = 0;
export const EXTRANONCE2_SIZE_BYTES = 0;
export const TOTAL_EXTRANONCE_SIZE_BYTES = EXTRANONCE1_SIZE_BYTES + EXTRANONCE2_SIZE_BYTES;

// Session id advertised in the mining.subscribe response (notify channel tag
// and the "extranonce1" slot on the wire). It must be a non-empty hex string
// because NerdMiner / Bitaxe firmwares reject the subscribe reply otherwise
// and disconnect immediately. It is NOT spliced into the coinbase by the
// worker — EXTRANONCE2_SIZE_BYTES = 0 guarantees the miner iterates nothing,
// so the coinbase stays byte-identical to mining/miner.py and the UTXO
// attestation is preserved regardless of what we put here.
export const SUBSCRIBE_SESSION_ID_BYTES = 4;
