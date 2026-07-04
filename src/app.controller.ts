import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Inject } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';

@Controller()
export class AppController {

  private uptime = new Date();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
  ) { }

  @Get('info')
  public async info() {


    const CACHE_KEY = 'SITE_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();
    const highScores = await this.addressSettingsService.getHighScores();

    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.uptime
    };

    //1 min
    await this.cacheManager.set(CACHE_KEY, data, 1 * 60 * 1000);

    return data;

  }

  @Get('pool')
  public async pool() {

    const CACHE_KEY = 'POOL_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const userAgents = await this.clientService.getUserAgents();
    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + parseInt(userAgent.count), 0);
    const blockHeight = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
    const blocksFound = await this.blocksService.getFoundBlocks();

    const data = {
      totalHashRate,
      blockHeight,
      totalMiners,
      blocksFound,
      fee: 0
    }

    //5 min
    await this.cacheManager.set(CACHE_KEY, data, 5 * 60 * 1000);

    return data;
  }

  @Get('network')
  public async network() {
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
    return miningInfo;
  }

  @Get('info/chart')
  public async infoChart() {


    const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    //10 min
    await this.cacheManager.set(CACHE_KEY, chartData, 10 * 60 * 1000);

    return chartData;


  }

  @Get('info/accounting')
  public async infoAccounting() {

    const CACHE_KEY = 'SITE_ACCOUNTING';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const accounting = await this.clientStatisticsService.getAccountingForPool();
    const highScores = await this.addressSettingsService.getHighScores();

    const top = highScores?.[0];
    const bestSubmissionDifficulty = top ? Number(top.bestDifficulty ?? 0) : 0;
    const bestSubmissionDifficultyAt = top ? top.updatedAt : null;

    let networkDifficultyPercent = 0;
    try {
      const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
      const networkDifficulty = Number(miningInfo?.difficulty ?? 0);
      if (networkDifficulty > 0) {
        networkDifficultyPercent = (accounting.totalCreditedDifficulty / networkDifficulty) * 100;
      }
    } catch (e) {
      networkDifficultyPercent = 0;
    }

    const data = {
      ...accounting,
      bestSubmissionDifficulty,
      bestSubmissionDifficultyAt,
      networkDifficultyPercent,
    };

    // 10s — short enough that the dashboard's "Best Submitted Share" reflects
    // newly-OK'd shares quickly without re-hitting the SQLite high-score query
    // on every viewer refresh.
    await this.cacheManager.set(CACHE_KEY, data, 10 * 1000);

    return data;
  }

}
