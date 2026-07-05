import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Block } from 'bitcoinjs-lib';

import { PayoutLedgerService } from '../ORM/payout-ledger/payout-ledger.service';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';
import { resolveConfiguredNetwork } from '../utils/elektron-network';

const HELP_TEXT = [
    'Elektron Net PPLNS Pool bot commands:',
    '/subscribe <address> - get notified here about blocks found and payouts for this address',
    '/unsubscribe <address> - stop notifications for this address',
    '/unsubscribe - stop all notifications for this chat',
    '/list - show which addresses you are subscribed to',
    '/balance <address> - show the pending (not yet paid out) balance for this address',
    '/help - show this message',
].join('\n');


@Injectable()
export class TelegramService implements OnModuleInit {

    private bot: AxiosInstance;
    private updateOffset = 0;
    private pollingTimer: NodeJS.Timeout;
    private conflictBackoffUntil = 0;
    private isPolling = false;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
        private readonly payoutLedgerService: PayoutLedgerService,
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
        if (Date.now() < this.conflictBackoffUntil) {
            return;
        }

        // The interval below fires every 2s regardless of whether the
        // previous call has come back yet -- on a slow/laggy connection to
        // api.telegram.org (seen e.g. behind Docker Desktop for Windows'
        // NAT/WSL2 networking), a single request taking longer than that
        // would otherwise let two getUpdates calls run at once from this
        // *same* process/token, which is enough on its own to make Telegram
        // reject one of them with a 409 conflict -- no second process
        // required.
        if (this.isPolling) {
            return;
        }
        this.isPolling = true;

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
            const description: string | undefined = e.response?.data?.description;

            // A 409 means Telegram is seeing getUpdates called concurrently
            // with this same token from somewhere else entirely (a leftover
            // old container/process that was never stopped, a second
            // deployment, a local test run, ...) -- not something the app
            // retrying faster can fix. Back off instead of retrying every
            // 2s forever and flooding the logs with the same line.
            if (e.response?.status === 409) {
                this.conflictBackoffUntil = Date.now() + 60000;
                console.error(
                    'Telegram getUpdates conflict: another process is polling this bot token '
                    + '(old container/process not stopped, or the token is used elsewhere). '
                    + 'Pausing polling for 60s. Find and stop the other instance -- this will '
                    + 'keep repeating until only one process uses this TELEGRAM_BOT_TOKEN.',
                );
                return;
            }

            console.error('Telegram polling failed:', description ?? e.message);
        } finally {
            this.isPolling = false;
        }
    }

    private async handleMessage(msg: any) {
        if (msg?.text == null) {
            return;
        }

        const text: string = msg.text.trim();
        const chatId = msg.chat.id;

        // /unsubscribe is checked before /subscribe's startsWith below would
        // never actually collide (they diverge at the 2nd character), kept
        // as separate branches for clarity rather than a shared prefix check.
        if (text.startsWith('/unsubscribe')) {
            const address = this.extractArg(text, '/unsubscribe');
            if (address == null) {
                const removed = await this.telegramSubscriptionsService.removeAllSubscriptions(chatId);
                await this.sendMessage(chatId, removed > 0
                    ? `Unsubscribed from all ${removed} address(es).`
                    : `You weren't subscribed to anything.`);
                return;
            }
            const removed = await this.telegramSubscriptionsService.removeSubscription(chatId, address);
            await this.sendMessage(chatId, removed
                ? `Unsubscribed from ${address}.`
                : `You weren't subscribed to ${address}.`);
            return;
        }

        if (text.startsWith('/subscribe')) {
            const address = this.extractArg(text, '/subscribe');
            if (!this.isValidAddress(address)) {
                await this.sendMessage(chatId, 'Invalid address. Usage: /subscribe <address>');
                return;
            }
            await this.telegramSubscriptionsService.saveSubscription(chatId, address);
            await this.sendMessage(chatId, `Subscribed! You'll be notified here about blocks found and payouts for ${address}.`);
            return;
        }

        if (text.startsWith('/list')) {
            const subscriptions = await this.telegramSubscriptionsService.getSubscriptionsForChat(chatId);
            await this.sendMessage(chatId, subscriptions.length > 0
                ? `Subscribed addresses:\n${subscriptions.map(s => s.address).join('\n')}`
                : `You're not subscribed to any address yet. Use /subscribe <address>.`);
            return;
        }

        if (text.startsWith('/balance')) {
            const address = this.extractArg(text, '/balance');
            if (!this.isValidAddress(address)) {
                await this.sendMessage(chatId, 'Usage: /balance <address>');
                return;
            }
            const pendingSats = await this.payoutLedgerService.getPendingTotal(address);
            await this.sendMessage(chatId, `Pending (not yet paid out) balance for ${address}: ${pendingSats.toLocaleString('en-US')} lep`);
            return;
        }

        if (text.startsWith('/help') || text.startsWith('/start')) {
            await this.sendMessage(chatId, HELP_TEXT);
            return;
        }

        console.log(msg);
    }

    // Everything after the command word, trimmed; undefined if nothing
    // follows (e.g. bare "/unsubscribe" vs "/unsubscribe <address>").
    private extractArg(text: string, command: string): string | undefined {
        const rest = text.slice(command.length).trim();
        return rest.length > 0 ? rest : undefined;
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
