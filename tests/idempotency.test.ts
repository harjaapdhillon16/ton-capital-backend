import { describe, expect, it } from 'vitest';
import { makeIdempotencyKey } from '../src/utils/idempotency.js';

describe('idempotency keys', () => {
  it('is deterministic for the same tuple', () => {
    const decision = {
      asset: 'BTC',
      action: 'OPEN_LONG'
    } as const;

    const keyA = makeIdempotencyKey('run-1', 'user-1', {
      ...decision,
      conviction: 'high',
      conviction_score: 9,
      risk_reward: 2.5,
      thesis: 'A',
      invalidation: 'B',
      position_pct: 5,
      stop_loss_pct: 3,
      take_profit_pct: 6,
      explanation_for_user: 'C'
    });

    const keyB = makeIdempotencyKey('run-1', 'user-1', {
      ...decision,
      conviction: 'low',
      conviction_score: 4,
      risk_reward: 1.2,
      thesis: 'Different text does not affect key',
      invalidation: 'Different',
      position_pct: 9,
      stop_loss_pct: 7,
      take_profit_pct: 8,
      explanation_for_user: 'Different'
    });

    expect(keyA).toEqual(keyB);
  });

  it('changes when action changes', () => {
    const base = {
      asset: 'BTC',
      conviction: 'high',
      conviction_score: 9,
      risk_reward: 2.2,
      thesis: 'A',
      invalidation: 'B',
      position_pct: 5,
      stop_loss_pct: 3,
      take_profit_pct: 6,
      explanation_for_user: 'C'
    } as const;

    const keyLong = makeIdempotencyKey('run-1', 'user-1', { ...base, action: 'OPEN_LONG' });
    const keyShort = makeIdempotencyKey('run-1', 'user-1', { ...base, action: 'OPEN_SHORT' });

    expect(keyLong).not.toEqual(keyShort);
  });
});
