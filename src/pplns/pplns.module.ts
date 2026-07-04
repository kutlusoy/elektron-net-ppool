import { Module } from '@nestjs/common';

import { NotificationModule } from '../services/notification.module';
import { WalletRpcService } from '../services/wallet-rpc.service';
import { PayoutSchedulerService } from './payout-scheduler.service';
import { RewardCalculatorService } from './reward-calculator.service';

// ORM dependencies (PplnsShareLogService, PayoutLedgerService,
// PoolAccountingService, MinerAccountSettingsService) come from their own
// @Global modules registered in AppModule; NotificationModule is imported
// explicitly here since it's a regular (non-global) module shared with
// AppModule, so PayoutSchedulerService can notify miners on payout.
@Module({
    imports: [
        NotificationModule,
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
