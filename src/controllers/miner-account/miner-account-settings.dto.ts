import { IsBoolean, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdateMinerAccountSettingsDto {

    // Explicitly nullable so a miner can clear their override and fall back
    // to the pool-wide MIN_PAYOUT_THRESHOLD_SATS again; omit the field
    // entirely to leave it unchanged.
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsInt()
    @Min(1)
    payoutThresholdSatsOverride?: number | null;

    @IsOptional()
    @IsBoolean()
    notifyOnPayout?: boolean;
}
