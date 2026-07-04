import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PayoutLedgerEntity } from './payout-ledger.entity';
import { PayoutLedgerService } from './payout-ledger.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PayoutLedgerEntity])],
    providers: [PayoutLedgerService],
    exports: [TypeOrmModule, PayoutLedgerService],
})
export class PayoutLedgerModule { }
