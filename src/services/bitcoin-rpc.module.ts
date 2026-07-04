import { Module } from '@nestjs/common';

import { BitcoinRpcService } from './bitcoin-rpc.service';

// Shared home for BitcoinRpcService so it stays a singleton (one ZMQ
// subscription, one pollMiningInfo timer) whether it's used from AppModule's
// own providers or from AuthModule's on-chain login verification --
// previously it was registered directly as an AppModule provider, which
// made it invisible to other feature modules (same issue NotificationModule
// solved for Discord/Telegram).
@Module({
    providers: [BitcoinRpcService],
    exports: [BitcoinRpcService],
})
export class BitcoinRpcModule { }
