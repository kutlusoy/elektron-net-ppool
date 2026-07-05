import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Block } from 'bitcoinjs-lib';

import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { resolveConfiguredNetwork } from '../utils/elektron-network';


@Injectable()
export class TelegramService implements OnModuleInit {

    private bot: AxiosInstance;
    private updateOffset = 0;
    private pollingTimer: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService
    ) {
        // .trim() guards against a trailing \r/whitespace on the token value
        // (e.g. a .env file edited on Windows and saved with CRLF line
        // endings), which would otherwise silently break every request to
        // the Telegram API with an invalid URL/token.
        const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN')?.trim();
        if (token == null || token.length < 1) {
            return;
        }
        this.bot = axios.create({
            baseURL: `https://api.telegram.org/bot${token}/`,
            timeout: 10000
        });
        console.log('Telegram bot init');


    }

    async onModuleInit(): Promise<void> {

        if (this.bot == null) {
            return;
        }

        // Under a multi-instance (e.g. PM2 cluster mode) deployment, only
        // instance 0 should poll -- otherwise every instance independently
        // calls getUpdates with the same stale offset and can all receive
        // (and reply to) the same update, producing duplicate messages like
        // two "Welcome" replies to a single /start. Mirrors the guard already
        // used by DiscordService/LogRotationService/PayoutSchedulerService.
        if (process.env.NODE_APP_INSTANCE != null && process.env.NODE_APP_INSTANCE != '0') {
            return;
        }

        await this.pollUpdates();
        this.pollingTimer = setInterval(async () => {
            await this.pollUpdates();
        }, 2000);
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        if (this.bot == null) {
            return;
        }

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        await Promise.all(subscribers.map(subscriber => {
            return this.sendMessage(subscriber.telegramChatId, `Block Found! Result: ${message}, Height: ${height}`);
        }));
    }

    // Phase 2 (concept doc §11): opt-in per miner via account settings
    // (notifyOnPayout), reusing the same /subscribe chat link as block-found
    // notifications -- a miner who hasn't run /subscribe simply gets no
    // message here since there's no chat to send it to.
    public async notifyPayoutSent(address: string, amountSats: number, txid: string) {
        if (this.bot == null) {
            return;
        }

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        await Promise.all(subscribers.map(subscriber => {
            return this.sendMessage(subscriber.telegramChatId, `Payout sent: ${amountSats} lep (txid: ${txid})`);
        }));
    }

    private async pollUpdates() {
        try {
            const response = await this.bot.get('getUpdates', {
                params: {
                    offset: this.updateOffset,
                    timeout: 0
                }
            });

            for (const update of response.data.result ?? []) {
                this.updateOffset = update.update_id + 1;
                await this.handleMessage(update.message);
            }
        } catch (e) {
            // Telegram's own error description (e.g. "Unauthorized" for a bad
            // token, or "terminated by other getUpdates request" if the same
            // token is polled from more than one place) is much more useful
            // here than the generic Axios "Request failed with status code
            // ___" message.
            console.error('Telegram polling failed:', e.response?.data?.description ?? e.message);
        }
    }

    private async handleMessage(msg: any) {
        if (msg?.text == null) {
            return;
        }

        if (msg.text.startsWith('/subscribe')) {
            const address = msg.text.split('/subscribe ')[1];
            if (!this.isValidAddress(address)) {
                await this.sendMessage(msg.chat.id, 'Invalid address.');
                return;
            }
            await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
            await this.sendMessage(msg.chat.id, 'Subscribed!');
            return;
        }

        if (msg.text.startsWith('/start')) {
            await this.sendMessage(msg.chat.id, 'Welcome to the Elektron Net PPLNS Pool bot. /subscribe <address> to get notified.');
            return;
        }

        console.log(msg);
    }

    // The generic `bitcoin-address-validation` npm package only recognizes
    // stock Bitcoin network prefixes, not Elektron Net's own bech32 HRP
    // (`be` on mainnet) -- it rejected every real mainnet address here.
    // Validate the same way BitcoinAddressValidator/StratumV1Client do
    // instead, against the pool's actually configured network.
    private isValidAddress(address: string | undefined): boolean {
        if (address == null || address.length < 1) {
            return false;
        }
        const network = resolveConfiguredNetwork(this.configService);
        if (network == null) {
            return false;
        }
        try {
            bitcoinjs.address.toOutputScript(address, network);
            return true;
        } catch {
            return false;
        }
    }

    private async sendMessage(chatId: number | string, text: string) {
        await this.bot.post('sendMessage', {
            chat_id: chatId,
            text
        });
    }
}
