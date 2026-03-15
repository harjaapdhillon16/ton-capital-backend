import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotTradingContext } from '../src/services/bot/context.js';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => ({}))
  }
}));

vi.mock('../src/config.js', () => ({
  getConfig: () => ({
    DEEPSEEK_API_URL: 'https://api.deepseek.test/chat/completions',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-reasoner'
  })
}));

vi.mock('../src/logger.js', () => ({
  logger: loggerMock
}));

vi.mock('../src/utils/time.js', () => ({
  sleep: vi.fn(async () => undefined)
}));

function testContext(): BotTradingContext {
  return {
    generated_at: new Date().toISOString(),
    profile: {
      user_id: 'u1',
      name: 'Harjaap',
      onboarding_completed: true,
      wallet_address: 'EQ-wallet',
      trade_wallet_address: 'EQ-trade',
      max_loss_pct: 20,
      allowed_assets: ['crypto']
    },
    portfolio: {
      total_balance_usdt: 50,
      equity_usdt: 49,
      pnl_day_usdt: 1,
      drawdown_pct: 2,
      trading_enabled: true
    },
    trade_wallet: {
      address: 'EQ-trade',
      usdt_balance: 50,
      ton_balance: 1
    },
    open_positions: [],
    recent_actions: []
  };
}

describe('generateBotChatReply', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns parsed answer from DeepSeek JSON payload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ answer: 'Your portfolio looks stable.' }) } }]
      })
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { generateBotChatReply } = await import('../src/services/ai/chat.js');
    const answer = await generateBotChatReply({
      userMessage: 'How am I doing?',
      history: [{ role: 'user', content: 'How am I doing?' }],
      context: testContext()
    });

    expect(answer).toBe('Your portfolio looks stable.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back deterministically after repeated failures', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ wrong_key: 'oops' }) } }]
      })
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { generateBotChatReply } = await import('../src/services/ai/chat.js');
    const answer = await generateBotChatReply({
      userMessage: 'What changed?',
      history: [{ role: 'user', content: 'What changed?' }],
      context: testContext()
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(answer).toContain('temporarily unavailable');
    expect(answer).toContain('Current balance');
  });
});
