import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PplnsShareEntity } from './pplns-share.entity';
import { PplnsShareLogService } from './pplns-shares.service';

@Global()
@Module({
    imports: [TypeOrmModule.forFeature([PplnsShareEntity])],
    providers: [PplnsShareLogService],
    exports: [TypeOrmModule, PplnsShareLogService],
})
export class PplnsSharesModule { }
