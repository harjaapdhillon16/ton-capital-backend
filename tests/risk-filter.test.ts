import { describe, expect, it } from 'vitest';
import { checkRisk } from '../src/services/risk/filter.js';
import type { ActiveUser } from '../src/types/domain.js';
import type { AiDecision } from '../src/types/ai.js';

function mockUser(overrides?: Partial<ActiveUser>): ActiveUser {
  return {
    id: 'u1',
    telegram_id: '123',
    wallet_address: null,
    trade_wallet_address: 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ',
    onboarding_completed: true,
    encrypted_mnemonic: 'enc',
    encryption_iv: 'iv',
    encryption_tag: 'tag',
    is_active: true,
    paused: false,
    total_balance_usdt: 1000,
    equity_usdt: 980,
    peak_equity_usdt: 1000,
    day_start_equity_usdt: 1000,
    risk: {
      max_loss_pct: 20,
      allowed_assets: ['crypto', 'gold'],
      conservative_mode: true
    },
    ...overrides
  };
}

const baseDecision: AiDecision = {
  asset: 'BTC',
  action: 'OPEN_LONG',
  conviction: 'high',
  conviction_score: 9,
  risk_reward: 2.5,
  thesis: 'Momentum positive',
  invalidation: 'Breakdown below support',
  position_pct: 12,
  stop_loss_pct: 4,
  take_profit_pct: 8,
  explanation_for_user: 'Price trend and funding suggest upside.'
};

describe('checkRisk', () => {
  it('caps position size to conservative max', () => {
    const result = checkRisk({
      user: mockUser(),
      decision: baseDecision,
      accountUsdt: 980,
      market: {
        asset: 'BTC',
        mark_price: 70_000,
        index_price: 70_010,
        funding_rate: 0.0001,
        open_interest: 100_000_000,
        long_ratio: 0.51,
        atr_pct: 2.1,
        crowding_bias: 'balanced',
        volatility_regime: 'normal',
        daily_change_pct: 0.5,
        candles_count: 20
      }
    });
    expect(result.allowed).toBe(true);
    expect(result.adjusted_position_pct).toBeLessThanOrEqual(5);
  });

  it('blocks when drawdown exceeds max loss', () => {
    const user = mockUser({ equity_usdt: 700, peak_equity_usdt: 1000 });
    const result = checkRisk({
      user,
      decision: baseDecision,
      accountUsdt: 700,
      market: null
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Drawdown');
  });

  it('blocks disabled asset classes', () => {
    const user = mockUser({
      risk: {
        max_loss_pct: 20,
        allowed_assets: ['gold'],
        conservative_mode: true
      }
    });
    const result = checkRisk({
      user,
      decision: baseDecision,
      accountUsdt: 980,
      market: null
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('disabled');
  });
});
