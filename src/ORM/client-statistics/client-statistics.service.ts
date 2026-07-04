import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';


@Injectable()
export class ClientStatisticsService {

    constructor(


        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    public async update(clientStatistic: Partial<ClientStatisticsEntity>) {

        await this.clientStatisticsRepository.update({
            address: clientStatistic.address,
            clientName: clientStatistic.clientName,
            sessionId: clientStatistic.sessionId,
            time: clientStatistic.time
        },
            {
                shares: clientStatistic.shares,
                acceptedCount: clientStatistic.acceptedCount,
                updatedAt: new Date()
            });

    }
    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
        // If no rows were updated, insert a new record
        await this.clientStatisticsRepository.insert(clientStatistic);
    }

    public async deleteOldStatistics() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('time < :time', { time: oneDayAgo.getTime() })
            .execute();
    }

    public async getChartDataForSite() {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time AS label,
                ROUND(((SUM(shares) * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;

    `;

        const result: any[] = await this.clientStatisticsRepository.query(query);


        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1)

    }


    // public async getHashRateForAddress(address: string) {

    //     const oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

    //     const query = `
    //         SELECT
    //         SUM(entry.shares) AS difficultySum
    //         FROM
    //             client_statistics_entity AS entry
    //         WHERE
    //             entry.address = ? AND entry.time > ${oneHour}
    //     `;

    //     const result = await this.clientStatisticsRepository.query(query, [address]);

    //     const difficultySum = result[0].difficultySum;

    //     return (difficultySum * 4294967296) / (600);

    // }

    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
                SELECT
                    time label,
                    (SUM(shares) * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = ? AND entry.time > ${yesterday.getTime()}
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT 144;

        `;

        const result = await this.clientStatisticsRepository.query(query, [address]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${oneHour.getTime()}
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
                createdAt,
                updatedAt,
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ?
            ORDER BY time DESC
            LIMIT 2;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        if (result.length < 1) {
            return 0;
        }

        const latestStat = result[0];

        if (result.length < 2) {
            const time = new Date(latestStat.updatedAt).getTime() - new Date(latestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return (latestStat.shares * 4294967296) / (time / 1000);
        } else {
            const secondLatestStat = result[1];
            const time = new Date(latestStat.updatedAt).getTime() - new Date(secondLatestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return ((latestStat.shares + secondLatestStat.shares) * 4294967296) / (time / 1000);
        }

    }

    public async getChartDataForSession(address: string, clientName: string, sessionId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.clear()
    }

    public async getAccountingForPool() {
        return await this.getAccounting('1 = 1', []);
    }

    public async getAccountingForAddress(address: string) {
        return await this.getAccounting('address = ?', [address]);
    }

    public async getAccountingForGroup(address: string, clientName: string) {
        return await this.getAccounting('address = ? AND clientName = ?', [address, clientName]);
    }

    public async getAccountingForSession(address: string, clientName: string, sessionId: string) {
        return await this.getAccounting(
            'address = ? AND clientName = ? AND sessionId = ?',
            [address, clientName, sessionId]
        );
    }

    private async getAccounting(whereClause: string, params: any[]) {
        const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
        const oneHourAgo = Date.now() - (60 * 60 * 1000);

        const query = `
            SELECT
                COALESCE(SUM(shares), 0) AS totalCreditedDifficulty,
                COALESCE(SUM(acceptedCount), 0) AS totalAcceptedShares,
                COALESCE(SUM(CASE WHEN time >= ${oneHourAgo} THEN shares ELSE 0 END), 0) AS creditedDifficultyLastHour,
                COALESCE(SUM(CASE WHEN time >= ${tenMinutesAgo} THEN shares ELSE 0 END), 0) AS sharesLast10Minutes,
                COALESCE(SUM(CASE WHEN time >= ${tenMinutesAgo} THEN acceptedCount ELSE 0 END), 0) AS acceptedSharesLast10Minutes
            FROM
                client_statistics_entity
            WHERE
                ${whereClause}
        `;

        const result = await this.clientStatisticsRepository.query(query, params);
        const row = result?.[0] ?? {};

        const sharesLast10Minutes = Number(row.sharesLast10Minutes ?? 0);
        const creditedDifficultyLastHour = Number(row.creditedDifficultyLastHour ?? 0);

        return {
            totalCreditedDifficulty: Number(row.totalCreditedDifficulty ?? 0),
            totalAcceptedShares: Number(row.totalAcceptedShares ?? 0),
            creditedDifficultyLastHour,
            acceptedSharesLast10Minutes: Number(row.acceptedSharesLast10Minutes ?? 0),
            hashRateLast10Minutes: (sharesLast10Minutes * 4294967296) / (10 * 60),
            hashRateLastHour: (creditedDifficultyLastHour * 4294967296) / (60 * 60),
        };
    }
}
