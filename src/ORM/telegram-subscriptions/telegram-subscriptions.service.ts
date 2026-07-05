import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TelegramSubscriptionsEntity } from './telegram-subscriptions.entity';


@Injectable()
export class TelegramSubscriptionsService {
    constructor(
        @InjectRepository(TelegramSubscriptionsEntity)
        private telegramSubscriptions: Repository<TelegramSubscriptionsEntity>
    ) {

    }

    public async getSubscriptions(address: string) {
        return await this.telegramSubscriptions.find({ where: { address } })
    }

    public async getSubscriptionsForChat(chatId: number) {
        return await this.telegramSubscriptions.find({ where: { telegramChatId: chatId } });
    }

    // Idempotent -- repeat /subscribe calls for the same chat+address used to
    // insert a new row every time (no uniqueness check), which meant that
    // chat got every block-found/payout notification duplicated once per
    // repeat subscribe.
    public async saveSubscription(chatId: number, address: string) {
        const existing = await this.telegramSubscriptions.findOne({ where: { telegramChatId: chatId, address } });
        if (existing != null) {
            return existing;
        }
        return await this.telegramSubscriptions.save({
            telegramChatId: chatId,
            address
        });
    }

    public async removeSubscription(chatId: number, address: string): Promise<boolean> {
        const result = await this.telegramSubscriptions.delete({ telegramChatId: chatId, address });
        return (result.affected ?? 0) > 0;
    }

    public async removeAllSubscriptions(chatId: number): Promise<number> {
        const result = await this.telegramSubscriptions.delete({ telegramChatId: chatId });
        return result.affected ?? 0;
    }
}