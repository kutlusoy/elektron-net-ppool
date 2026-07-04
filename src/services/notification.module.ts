import { Module } from '@nestjs/common';

import { DiscordService } from './discord.service';
import { NotificationService } from './notification.service';
import { TelegramService } from './telegram.service';

// Shared home for DiscordService/TelegramService/NotificationService so they
// stay singletons (one Telegram bot poller, one Discord client) whether
// they're used from AppModule's own controllers or from PplnsModule's
// PayoutSchedulerService -- previously these three were registered directly
// as AppModule providers, which made them invisible to other feature
// modules like PplnsModule.
@Module({
    providers: [DiscordService, TelegramService, NotificationService],
    exports: [NotificationService],
})
export class NotificationModule { }
