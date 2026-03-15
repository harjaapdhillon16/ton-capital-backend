import type { AiDecision } from './ai.js';

export type AssetClass = 'crypto' | 'gold' | 'oil' | 'stocks' | 'forex';

export type UserRiskProfile = {
  max_loss_pct: number;
  allowed_assets: AssetClass[];
  conservative_mode: boolean;
};

export type ActiveUser = {
  id: string;
  telegram_id: string;
  wallet_address: string | null;
  trade_wallet_address: string | null;
  onboarding_completed: boolean;
  encrypted_mnemonic: string | null;
  encryption_iv: string | null;
  encryption_tag: string | null;
  is_active: boolean;
  paused: boolean;
  total_balance_usdt: number;
  equity_usdt: number;
  peak_equity_usdt: number;
  day_start_equity_usdt: number;
  risk: UserRiskProfile;
};

export type RiskDecision = {
  allowed: boolean;
  reason: string;
  adjusted_position_pct: number;
  adjusted_leverage: number;
  rejection_category?: 'readiness' | 'signal_quality' | 'drawdown' | 'guardrail' | 'asset_block' | 'funding';
};

export type TradeExecutionResult = {
  status: 'executed' | 'skipped' | 'failed';
  external_id?: string;
  tx_hash?: string;
  reason?: string;
  order_type?: 'market_open' | 'market_close';
  stop_trigger_price?: number;
  take_trigger_price?: number;
  execution_meta?: Record<string, unknown>;
};

export type DecisionEnvelope = {
  run_id: string;
  user_id: string;
  decision: AiDecision;
  idempotency_key: string;
};
