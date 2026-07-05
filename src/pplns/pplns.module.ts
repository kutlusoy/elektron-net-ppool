import { Module } from '@nestjs/common';

import { BitcoinRpcModule } from '../services/bitcoin-rpc.module';
import { NotificationModule } from '../services/notification.module';
import { WalletRpcService } from '../services/wallet-rpc.service';
import { PayoutSchedulerService } from './payout-scheduler.service';
import { RewardCalculatorService } from './reward-calculator.service';

// ORM dependencies (PplnsShareLogService, PayoutLedgerService,
// PoolAccountingService, MinerAccountSettingsService) come from their own
// @Global modules registered in AppModule; NotificationModule/BitcoinRpcModule
// are imported explicitly here since they're regular (non-global) modules
// shared with AppModule, so PayoutSchedulerService can notify miners on
// payout and read the current chain height for coinbase maturity checks.
@Module({
    imports: [
        NotificationModule,
        BitcoinRpcModule,
    ],
    providers: [
        WalletRpcService,
        RewardCalculatorService,
        PayoutSchedulerService,
    ],
    exports: [
        WalletRpcService,
        RewardCalculatorService,
        PayoutSchedulerService,
    ],
})
export class PplnsModule { }
