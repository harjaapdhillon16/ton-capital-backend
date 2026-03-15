import {
  getAppProfileByUserId,
  getFeedByUser,
  getPortfolioByUser,
  getPositionsByUser
} from '../../db/repository.js';
import { getTradeWalletBalancesForUser } from '../wallets/tradeBalances.js';

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export type BotTradingContext = {
  generated_at: string;
  profile: {
    user_id: string;
    name: string;
    onboarding_completed: boolean;
    wallet_address: string | null;
    trade_wallet_address: string | null;
    max_loss_pct: number;
    allowed_assets: string[];
  };
  portfolio: {
    total_balance_usdt: number;
    equity_usdt: number;
    pnl_day_usdt: number;
    drawdown_pct: number;
    trading_enabled: boolean;
  };
  trade_wallet: {
    address: string;
    usdt_balance: number;
    ton_balance: number;
  };
  open_positions: Array<{
    asset: string;
    direction: string;
    size_usdt: number;
    leverage: number;
    entry_price: number;
    mark_price: number;
    pnl_usdt: number;
    stop_loss_pct: number;
    opened_at: string;
  }>;
  recent_actions: Array<{
    created_at: string;
    asset: string;
    action: string;
    thesis: string;
    invalidation: string;
    explanation_for_user: string;
  }>;
};

export async function buildBotTradingContext(userId: string): Promise<BotTradingContext> {
  const profile = await getAppProfileByUserId(userId);
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  const displayName = profile.display_name || fullName || profile.username || 'Investor';

  const [portfolioRaw, positionsRaw, feedRaw, tradeWalletBalances] = await Promise.all([
    getPortfolioByUser(userId),
    getPositionsByUser(userId),
    getFeedByUser(userId),
    getTradeWalletBalancesForUser({
      userId,
      tradeWalletAddress: profile.trade_wallet_address
    })
  ]);

  const positionRows = positionsRaw.slice(0, 10).map((item) => ({
    asset: asString(item.asset),
    direction: asString(item.direction),
    size_usdt: asNumber(item.size_usdt),
    leverage: asNumber(item.leverage),
    entry_price: asNumber(item.entry_price),
    mark_price: asNumber(item.mark_price),
    pnl_usdt: asNumber(item.pnl_usdt),
    stop_loss_pct: asNumber(item.stop_loss_pct),
    opened_at: asString(item.opened_at)
  }));

  const recentActions = feedRaw.slice(0, 10).map((item) => ({
    created_at: asString(item.created_at),
    asset: asString(item.asset),
    action: asString(item.action),
    thesis: asString(item.thesis),
    invalidation: asString(item.invalidation),
    explanation_for_user: asString(item.explanation_for_user)
  }));

  return {
    generated_at: new Date().toISOString(),
    profile: {
      user_id: profile.id,
      name: displayName,
      onboarding_completed: profile.onboarding_completed,
      wallet_address: profile.wallet_address,
      trade_wallet_address: tradeWalletBalances.trade_wallet_address,
      max_loss_pct: profile.max_loss_pct,
      allowed_assets: profile.allowed_assets
    },
    portfolio: {
      total_balance_usdt: asNumber(portfolioRaw.total_balance_usdt),
      equity_usdt: asNumber(portfolioRaw.equity_usdt),
      pnl_day_usdt: asNumber(portfolioRaw.pnl_day_usdt),
      drawdown_pct: asNumber(portfolioRaw.drawdown_pct),
      trading_enabled: asBoolean(portfolioRaw.trading_enabled, true)
    },
    trade_wallet: {
      address: tradeWalletBalances.trade_wallet_address,
      usdt_balance: tradeWalletBalances.usdt_balance,
      ton_balance: tradeWalletBalances.ton_balance
    },
    open_positions: positionRows,
    recent_actions: recentActions
  };
}
