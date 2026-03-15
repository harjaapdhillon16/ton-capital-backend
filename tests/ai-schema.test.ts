import { describe, expect, it } from 'vitest';
import { aiDecisionArraySchema } from '../src/types/ai.js';

describe('aiDecision schema', () => {
  it('accepts valid decision set', () => {
    const parsed = aiDecisionArraySchema.parse([
      {
        asset: 'BTC',
        action: 'OPEN_LONG',
        conviction: 'high',
        conviction_score: 9,
        risk_reward: 2.4,
        thesis: 'Trend supports upside',
        invalidation: 'Break below support',
        position_pct: 5,
        stop_loss_pct: 3,
        take_profit_pct: 6,
        explanation_for_user: 'The market is showing steady strength.'
      }
    ]);

    expect(parsed.length).toBe(1);
  });

  it('rejects malformed actions', () => {
    expect(() =>
      aiDecisionArraySchema.parse([
        {
          asset: 'BTC',
          action: 'BUY',
          conviction: 'high',
          conviction_score: 9,
          risk_reward: 2.5,
          thesis: 'x',
          invalidation: 'y',
          position_pct: 5,
          stop_loss_pct: 3,
          take_profit_pct: 5,
          explanation_for_user: 'z'
        }
      ])
    ).toThrow();
  });
});
