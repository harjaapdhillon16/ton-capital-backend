import { z } from 'zod';
import type { MvpAsset } from '../constants/trading.js';

export const aiActionSchema = z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'HOLD']);
export const convictionSchema = z.enum(['high', 'medium', 'low']);

export const aiDecisionSchema = z.object({
  asset: z.string().min(1),
  action: aiActionSchema,
  conviction: convictionSchema,
  conviction_score: z.number().min(1).max(10),
  risk_reward: z.number().min(0),
  thesis: z.string().min(1),
  invalidation: z.string().min(1),
  position_pct: z.number().min(0).max(25),
  stop_loss_pct: z.number().min(0.5).max(20),
  take_profit_pct: z.number().min(0.5).max(50).optional(),
  explanation_for_user: z.string().min(1)
});

export const aiDecisionArraySchema = z.array(aiDecisionSchema);

export type AiDecision = z.infer<typeof aiDecisionSchema>;

export type StormAssetContext = {
  asset: MvpAsset;
  mark_price: number;
  index_price: number;
  funding_rate: number;
  open_interest: number;
  long_ratio: number;
  atr_pct: number;
  crowding_bias: 'crowded_long' | 'crowded_short' | 'balanced';
  volatility_regime: 'low' | 'normal' | 'high';
  daily_change_pct: number;
  candles_count: number;
};

export type MarketBriefing = {
  timestamp: string;
  prices: Record<string, number>;
  market_context: Partial<Record<MvpAsset, StormAssetContext>>;
  news: Array<{
    title: string;
    sentiment: 'positive' | 'negative' | 'neutral';
    source: string;
    published: string;
  }>;
  fearGreed: {
    value: number;
    classification: string;
  };
  whaleFlows: Array<{
    wallet: string;
    asset: string;
    direction: 'inflow' | 'outflow';
    amount_usd: number;
    timestamp: string;
  }>;
};
