import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { LogRotationService } from './services/log-rotation.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { NotificationModule } from './services/notification.module';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { ExternalSharesService } from './services/external-shares.service';
import { ExternalShareController } from './controllers/external-share/external-share.controller';
import { ExternalSharesModule } from './ORM/external-shares/external-shares.module';
import { PplnsSharesModule } from './ORM/pplns-shares/pplns-shares.module';
import { PayoutLedgerModule } from './ORM/payout-ledger/payout-ledger.module';
import { PoolAccountingModule } from './ORM/pool-accounting/pool-accounting.module';
import { MinerAccountSettingsModule } from './ORM/miner-account-settings/miner-account-settings.module';
import { PplnsModule } from './pplns/pplns.module';
import { PplnsController } from './controllers/pplns/pplns.controller';
import { AuthModule } from './auth/auth.module';
import { MinerAccountController } from './controllers/miner-account/miner-account.controller';

const ORMModules = [
    ClientStatisticsModule,
    ClientModule,
    AddressSettingsModule,
    TelegramSubscriptionsModule,
    BlocksModule,
    RpcBlocksModule,
    ExternalSharesModule,
    PplnsSharesModule,
    PayoutLedgerModule,
    PoolAccountingModule,
    MinerAccountSettingsModule
]

@Module({
    imports: [
        // isGlobal is required so that ConfigService is injectable from
        // PplnsSharesModule/PayoutLedgerModule/PoolAccountingModule/PplnsModule
        // (separate feature modules, unlike the pre-PPLNS services which are
        // all registered directly on AppModule's own providers array).
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
            type: 'sqlite',
            database: './DB/public-pool.sqlite',
            synchronize: true,
            autoLoadEntities: true,
            logging: false,
            enableWAL: true,
            busyTimeout: 30 * 1000,

        }),
        CacheModule.register(),
        ScheduleModule.forRoot(),
        HttpModule,
        NotificationModule,
        AuthModule,
        PplnsModule,
        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController,
        ExternalShareController,
        PplnsController,
        MinerAccountController
    ],
    providers: [
        AppService,
        StratumV1Service,
        BitcoinRpcService,
        BitcoinAddressValidator,
        StratumV1JobsService,
        BTCPayService,
        BraiinsService,
        ExternalSharesService,
        LogRotationService,
    ],
})
export class AppModule {
    constructor() {

    }
}
