import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PoolAccountingEntity } from './pool-accounting.entity';
import { PoolAccountingService } from './pool-accounting.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PoolAccountingEntity])],
    providers: [PoolAccountingService],
    exports: [TypeOrmModule, PoolAccountingService],
})
export class PoolAccountingModule { }
