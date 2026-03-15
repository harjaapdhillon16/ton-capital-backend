import { describe, expect, it, vi } from 'vitest';
import {
  handlePrivateTextMessage,
  ONBOARDING_BLOCK_MESSAGE,
  TEMPORARY_ERROR_MESSAGE,
  type BotChatDependencies
} from '../src/bot/chatHandler.js';
import type { BotTradingContext } from '../src/services/bot/context.js';

function mockContext(): BotTradingContext {
  return {
    generated_at: new Date().toISOString(),
    profile: {
      user_id: 'u1',
      name: 'Harjaap',
      onboarding_completed: true,
      wallet_address: 'EQ-wallet',
      trade_wallet_address: 'EQ-trade',
      max_loss_pct: 20,
      allowed_assets: ['crypto', 'gold']
    },
    portfolio: {
      total_balance_usdt: 120,
      equity_usdt: 118,
      pnl_day_usdt: 1.5,
      drawdown_pct: 2.1,
      trading_enabled: true
    },
    trade_wallet: {
      address: 'EQ-trade',
      usdt_balance: 120,
      ton_balance: 1.1
    },
    open_positions: [],
    recent_actions: []
  };
}

function baseDeps(): BotChatDependencies {
  return {
    getUserIdByTelegramId: vi.fn(async () => 'u1'),
    buildBotTradingContext: vi.fn(async () => mockContext()),
    appendBotConversationMessage: vi.fn(async () => undefined),
    getRecentBotConversationMessages: vi.fn(async () => [
      { role: 'user', content: 'hello', created_at: new Date().toISOString() }
    ]),
    generateBotChatReply: vi.fn(async () => 'AI response')
  };
}

describe('handlePrivateTextMessage', () => {
  it('ignores non-private chats', async () => {
    const reply = vi.fn(async () => undefined);
    const deps = baseDeps();

    await handlePrivateTextMessage(
      {
        chatType: 'group',
        text: 'what is my status',
        telegramId: '1001',
        chatId: '2001',
        messageId: 10,
        reply
      },
      deps
    );

    expect(reply).not.toHaveBeenCalled();
    expect(deps.getUserIdByTelegramId).not.toHaveBeenCalled();
  });

  it('ignores command text in private chat', async () => {
    const reply = vi.fn(async () => undefined);
    const deps = baseDeps();

    await handlePrivateTextMessage(
      {
        chatType: 'private',
        text: '/status',
        telegramId: '1001',
        chatId: '2001',
        messageId: 10,
        reply
      },
      deps
    );

    expect(reply).not.toHaveBeenCalled();
    expect(deps.getUserIdByTelegramId).not.toHaveBeenCalled();
  });

  it('blocks unknown users and asks for onboarding', async () => {
    const reply = vi.fn(async () => undefined);
    const deps = baseDeps();
    deps.getUserIdByTelegramId = vi.fn(async () => null);

    await handlePrivateTextMessage(
      {
        chatType: 'private',
        text: 'hello agent',
        telegramId: '1001',
        chatId: '2001',
        messageId: 10,
        reply
      },
      deps
    );

    expect(reply).toHaveBeenCalledWith(ONBOARDING_BLOCK_MESSAGE);
    expect(deps.appendBotConversationMessage).not.toHaveBeenCalled();
  });

  it('stores both turns and replies with AI answer for onboarded users', async () => {
    const reply = vi.fn(async () => undefined);
    const deps = baseDeps();

    await handlePrivateTextMessage(
      {
        chatType: 'private',
        text: 'what changed today?',
        telegramId: '1001',
        chatId: '2001',
        messageId: 10,
        reply
      },
      deps
    );

    expect(deps.appendBotConversationMessage).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith('AI response');
  });

  it('falls back gracefully when context/AI flow fails', async () => {
    const reply = vi.fn(async () => undefined);
    const deps = baseDeps();
    deps.buildBotTradingContext = vi.fn(async () => {
      throw new Error('boom');
    });

    await handlePrivateTextMessage(
      {
        chatType: 'private',
        text: 'hello',
        telegramId: '1001',
        chatId: '2001',
        messageId: 10,
        reply
      },
      deps
    );

    expect(reply).toHaveBeenCalledWith(TEMPORARY_ERROR_MESSAGE);
    expect(deps.appendBotConversationMessage).toHaveBeenCalledTimes(2);
  });
});
