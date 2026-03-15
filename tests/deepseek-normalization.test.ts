import { beforeEach, describe, expect, it, vi } from 'vitest';

function applyEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test';
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
  process.env.TONCENTER_RPC_URL = process.env.TONCENTER_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC';
  process.env.STORM_API_URL = process.env.STORM_API_URL || 'https://api5.storm.tg/api';
  process.env.ORACLE_URL = process.env.ORACLE_URL || 'https://oracle.storm.tg';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
  process.env.USDT_JETTON_MASTER = process.env.USDT_JETTON_MASTER || 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
  process.env.AGENT_WALLET_ADDRESS =
    process.env.AGENT_WALLET_ADDRESS || 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ';
  process.env.AGENT_WALLET_MNEMONIC =
    process.env.AGENT_WALLET_MNEMONIC ||
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
}

const briefing = {
  timestamp: new Date().toISOString(),
  prices: { BTC: 70000 },
  market_context: {
    BTC: {
      asset: 'BTC',
      mark_price: 70000,
      index_price: 70010,
      funding_rate: 0.0001,
      open_interest: 100000000,
      long_ratio: 0.52,
      atr_pct: 2.2,
      crowding_bias: 'balanced',
      volatility_regime: 'normal',
      daily_change_pct: 1,
      candles_count: 20
    }
  },
  news: [],
  fearGreed: {
    value: 50,
    classification: 'Neutral'
  },
  whaleFlows: []
} as const;

describe('deepseek normalization and gates', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    applyEnv();
  });

  it('normalizes mixed formatting into valid decisions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decisions: [
                  {
                    asset: 'btc',
                    action: 'long',
                    conviction: 'High',
                    risk_reward: '2.5',
                    thesis: 'Momentum positive',
                    invalidation: 'Lose support',
                    position_pct: 7,
                    stop_loss_pct: 3,
                    explanation_for_user: 'Trend remains strong.'
                  }
                ]
              })
            }
          }
        ]
      })
    } as Response);

    const { analyzeWithDeepSeek } = await import('../src/services/ai/deepseek.js');
    const decisions = await analyzeWithDeepSeek({ ...briefing });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decisions[0]?.asset).toBe('BTC');
    expect(decisions[0]?.action).toBe('OPEN_LONG');
    expect(decisions[0]?.conviction_score).toBeGreaterThanOrEqual(8);
  });

  it('forces HOLD when signal quality is below threshold', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                decisions: [
                  {
                    asset: 'BTC',
                    action: 'OPEN_LONG',
                    conviction: 'medium',
                    conviction_score: 6,
                    risk_reward: 1.2,
                    thesis: 'Weak setup',
                    invalidation: 'none',
                    position_pct: 3,
                    stop_loss_pct: 2,
                    explanation_for_user: 'weak setup'
                  }
                ]
              })
            }
          }
        ]
      })
    } as Response);

    const { analyzeWithDeepSeek } = await import('../src/services/ai/deepseek.js');
    const decisions = await analyzeWithDeepSeek({ ...briefing });

    expect(decisions[0]?.action).toBe('HOLD');
  });
});
