import {
  MAX_CRYPTO_LEVERAGE,
  MAX_NON_CRYPTO_LEVERAGE,
  MAX_POSITION_PCT,
  MIN_CONVICTION_SCORE,
  MIN_READY_USDT,
  MIN_RISK_REWARD
} from '../../constants/trading.js';
import type { StormAssetContext, AiDecision } from '../../types/ai.js';
import type { ActiveUser, AssetClass, RiskDecision } from '../../types/domain.js';

const ASSET_CLASS_MAP: Record<string, AssetClass> = {
  BTC: 'crypto',
  ETH: 'crypto',
  TON: 'crypto',
  SOL: 'crypto',
  GOLD: 'gold',
  XAU: 'gold',
  XAUUSD: 'gold',
  OIL: 'oil',
  WTI: 'oil',
  TSLA: 'stocks',
  NVDA: 'stocks',
  AAPL: 'stocks',
  EURUSD: 'forex',
  GBPUSD: 'forex'
};

export function classifyAsset(asset: string): AssetClass {
  return ASSET_CLASS_MAP[asset.toUpperCase()] ?? 'crypto';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function kellyPositionPct(decision: AiDecision, market: StormAssetContext | null): number {
  const rr = Math.max(0.01, decision.risk_reward);
  const convictionProb = clamp(0.45 + decision.conviction_score * 0.035, 0.5, 0.8);
  const rawKelly = (convictionProb * (rr + 1) - 1) / rr;
  const fractionalKelly = clamp(rawKelly, 0.01, 0.2) * 0.35;

  let volatilityAdj = 1;
  const atrPct = market?.atr_pct ?? 0;
  if (atrPct >= 6) {
    volatilityAdj = 0.5;
  } else if (atrPct >= 3) {
    volatilityAdj = 0.7;
  } else if (atrPct > 0 && atrPct <= 1.1) {
    volatilityAdj = 1.1;
  }

  const suggested = fractionalKelly * 100 * volatilityAdj;
  return clamp(Number(suggested.toFixed(4)), 1, MAX_POSITION_PCT);
}

export function checkRisk(params: {
  user: ActiveUser;
  decision: AiDecision;
  accountUsdt: number;
  market: StormAssetContext | null;
}): RiskDecision {
  const { user, decision, accountUsdt, market } = params;

  if (!user.onboarding_completed) {
    return {
      allowed: false,
      reason: 'User onboarding is incomplete.',
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'readiness'
    };
  }

  if (!user.trade_wallet_address || !user.encrypted_mnemonic || !user.encryption_iv || !user.encryption_tag) {
    return {
      allowed: false,
      reason: 'Trade wallet custody is incomplete.',
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'readiness'
    };
  }

  if (accountUsdt < MIN_READY_USDT) {
    return {
      allowed: false,
      reason: `Trade wallet balance below minimum (${MIN_READY_USDT} USDT).`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'readiness'
    };
  }

  if (decision.action === 'CLOSE') {
    return {
      allowed: true,
      reason: 'Close action always allowed for risk reduction.',
      adjusted_position_pct: 0,
      adjusted_leverage: 1
    };
  }

  if (user.paused) {
    return {
      allowed: false,
      reason: 'User is paused.',
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'readiness'
    };
  }

  if (decision.conviction_score < MIN_CONVICTION_SCORE) {
    return {
      allowed: false,
      reason: `Signal conviction ${decision.conviction_score} is below minimum ${MIN_CONVICTION_SCORE}.`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'signal_quality'
    };
  }

  if (decision.risk_reward < MIN_RISK_REWARD) {
    return {
      allowed: false,
      reason: `Signal risk/reward ${decision.risk_reward.toFixed(2)} is below minimum ${MIN_RISK_REWARD}.`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'signal_quality'
    };
  }

  const drawdownPct =
    user.peak_equity_usdt > 0
      ? ((user.peak_equity_usdt - user.equity_usdt) / user.peak_equity_usdt) * 100
      : 0;

  if (drawdownPct >= user.risk.max_loss_pct) {
    return {
      allowed: false,
      reason: `Drawdown ${drawdownPct.toFixed(2)}% breached max loss ${user.risk.max_loss_pct}%.`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'drawdown'
    };
  }

  const dayLossPct =
    user.day_start_equity_usdt > 0
      ? ((user.day_start_equity_usdt - user.equity_usdt) / user.day_start_equity_usdt) * 100
      : 0;

  if (dayLossPct > 7) {
    return {
      allowed: false,
      reason: 'Daily loss guardrail breached.',
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'guardrail'
    };
  }

  const assetClass = classifyAsset(decision.asset);
  if (!user.risk.allowed_assets.includes(assetClass)) {
    return {
      allowed: false,
      reason: `Asset class ${assetClass} is disabled by user.`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'asset_block'
    };
  }

  const fundingRate = market?.funding_rate ?? 0;
  if (decision.action === 'OPEN_LONG' && fundingRate > 0.0002) {
    return {
      allowed: false,
      reason: `Funding rate ${fundingRate.toFixed(6)} is too high for long exposure.`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'funding'
    };
  }

  if (decision.action === 'OPEN_SHORT' && fundingRate < -0.0002) {
    return {
      allowed: false,
      reason: `Funding rate ${fundingRate.toFixed(6)} is too low for short exposure.`,
      adjusted_position_pct: 0,
      adjusted_leverage: 1,
      rejection_category: 'funding'
    };
  }

  const suggestedPct = kellyPositionPct(decision, market);
  const cappedPosition = Math.min(decision.position_pct, suggestedPct, MAX_POSITION_PCT);
  const leverageCap = assetClass === 'crypto' ? MAX_CRYPTO_LEVERAGE : MAX_NON_CRYPTO_LEVERAGE;

  return {
    allowed: true,
    reason: 'Allowed',
    adjusted_position_pct: Number(cappedPosition.toFixed(4)),
    adjusted_leverage: leverageCap
  };
}
