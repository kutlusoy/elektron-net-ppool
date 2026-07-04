import { Module } from '@nestjs/common';

import { WalletRpcService } from '../services/wallet-rpc.service';
import { PayoutSchedulerService } from './payout-scheduler.service';
import { RewardCalculatorService } from './reward-calculator.service';

// ORM dependencies (PplnsShareLogService, PayoutLedgerService, PoolAccountingService)
// come from their own @Global modules registered in AppModule, so this module
// only needs to provide the PPLNS-specific business logic.
@Module({
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
