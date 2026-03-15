import { Bot } from 'grammy';
import { getConfig } from '../config.js';
import {
  appendBotConversationMessage,
  getPortfolioByUser,
  getRecentBotConversationMessages,
  getUserIdByTelegramId,
  setUserPause
} from '../db/repository.js';
import { logger } from '../logger.js';
import { buildBotTradingContext } from '../services/bot/context.js';
import { generateBotChatReply } from '../services/ai/chat.js';
import { handlePrivateTextMessage, type BotChatDependencies } from './chatHandler.js';

const defaultBotChatDependencies: BotChatDependencies = {
  getUserIdByTelegramId,
  buildBotTradingContext,
  appendBotConversationMessage,
  getRecentBotConversationMessages,
  generateBotChatReply
};

export function createTelegramBot(): Bot {
  const bot = new Bot(getConfig().TELEGRAM_BOT_TOKEN);

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Welcome to TON Capital AI, where our AI Agent manages long-term capital. You can chat with our agent right after you set up your account by opening the Mini App.'
    );
  });

  bot.command('status', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const userId = await getUserIdByTelegramId(telegramId);
    if (!userId) {
      await ctx.reply('User not found. Send /start first.');
      return;
    }

    const portfolio = await getPortfolioByUser(userId);
    await ctx.reply(
      `Balance: ${Number(portfolio.total_balance_usdt).toFixed(2)} USDT\n` +
        `Equity: ${Number(portfolio.equity_usdt).toFixed(2)} USDT\n` +
        `Drawdown: ${Number(portfolio.drawdown_pct).toFixed(2)}%\n` +
        `Trading: ${portfolio.trading_enabled ? 'ON' : 'PAUSED'}`
    );
  });

  bot.command('pause', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const userId = await getUserIdByTelegramId(telegramId);
    if (!userId) {
      await ctx.reply('User not found. Send /start first.');
      return;
    }
    await setUserPause(userId, true);
    await ctx.reply('Trading paused for your account.');
  });

  bot.command('resume', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const userId = await getUserIdByTelegramId(telegramId);
    if (!userId) {
      await ctx.reply('User not found. Send /start first.');
      return;
    }
    await setUserPause(userId, false);
    await ctx.reply('Trading resumed for your account.');
  });

  bot.command('withdraw', async (ctx) => {
    await ctx.reply('Use Mini App > Settings > Withdraw to submit a request with destination wallet.');
  });

  bot.command('risk', async (ctx) => {
    await ctx.reply('Use Mini App > Settings to edit max loss and allowed asset classes.');
  });

  bot.command('help', async (ctx) => {
    await ctx.reply('/start, /status, /pause, /resume, /withdraw, /risk\nYou can also ask questions directly in this chat.');
  });

  bot.on('message:text', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) {
      return;
    }

    await handlePrivateTextMessage(
      {
        chatType: ctx.chat.type,
        text: ctx.message.text,
        telegramId,
        chatId: String(ctx.chat.id),
        messageId: ctx.message.message_id,
        reply: async (text) => {
          await ctx.reply(text, {
            link_preview_options: { is_disabled: true }
          });
        }
      },
      defaultBotChatDependencies,
      (error, userId) => {
        logger.error({ err: error.message, userId }, 'Telegram chat response failed');
      }
    );
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    logger.error({ err: message }, 'Telegram bot update failed');
  });

  return bot;
}
