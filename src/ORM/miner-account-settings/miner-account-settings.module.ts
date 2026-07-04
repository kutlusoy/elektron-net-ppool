import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MinerAccountSettingsEntity } from './miner-account-settings.entity';
import { MinerAccountSettingsService } from './miner-account-settings.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([MinerAccountSettingsEntity])],
    providers: [MinerAccountSettingsService],
    exports: [TypeOrmModule, MinerAccountSettingsService],
})
export class MinerAccountSettingsModule { }
