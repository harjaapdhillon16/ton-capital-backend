import { MVP_ASSETS } from '../../constants/trading.js';
import {
  closeMissingOpenPositions,
  updateUserBalanceSnapshot,
  upsertOpenPositionSnapshot
} from '../../db/repository.js';
import { logger } from '../../logger.js';
import type { MarketBriefing } from '../../types/ai.js';
import type { ActiveUser } from '../../types/domain.js';
import { getTradeWalletBalancesForUser } from '../wallets/tradeBalances.js';
import { StormExecutionService } from '../execution/storm.js';

export async function syncUserCapitalState(user: ActiveUser): Promise<ActiveUser> {
  if (!user.trade_wallet_address) {
    return user;
  }

  try {
    const balances = await getTradeWalletBalancesForUser({
      userId: user.id,
      tradeWalletAddress: user.trade_wallet_address
    });

    const snapshot = await updateUserBalanceSnapshot({
      user_id: user.id,
      equity_usdt: balances.usdt_balance,
      total_balance_usdt: balances.usdt_balance
    });

    return {
      ...user,
      total_balance_usdt: snapshot.total_balance_usdt,
      equity_usdt: snapshot.equity_usdt,
      peak_equity_usdt: snapshot.peak_equity_usdt,
      day_start_equity_usdt: snapshot.day_start_equity_usdt
    };
  } catch (error) {
    logger.warn({ userId: user.id, err: (error as Error).message }, 'Failed to sync user balance snapshot');
    return user;
  }
}

export async function syncUserPositions(params: {
  user: ActiveUser;
  briefing: MarketBriefing;
  execution: StormExecutionService;
}): Promise<void> {
  const { user, briefing, execution } = params;

  if (!user.trade_wallet_address) {
    return;
  }

  try {
    const markPrices: Partial<Record<string, number>> = {};
    for (const asset of MVP_ASSETS) {
      const byContext = briefing.market_context?.[asset]?.mark_price;
      const byPrice = briefing.prices[asset];
      markPrices[asset] = byContext ?? byPrice ?? 0;
    }

    const openPositions = await execution.getOpenPositionsForUser({
      user,
      assets: [...MVP_ASSETS],
      markPrices
    });

    for (const position of openPositions) {
      await upsertOpenPositionSnapshot({
        user_id: user.id,
        asset: position.asset,
        direction: position.direction,
        size_usdt: position.size_usdt,
        leverage: position.leverage,
        entry_price: position.entry_price,
        mark_price: position.mark_price,
        pnl_usdt: position.pnl_usdt,
        stop_loss_pct: 0,
        storm_position_id: position.storm_position_id,
        base_size_9: position.size_base_9,
        margin_usdt: position.margin_usdt,
        open_notional_usdt: position.size_usdt
      });
    }

    await closeMissingOpenPositions(
      user.id,
      openPositions.map((position) => position.key)
    );
  } catch (error) {
    logger.warn({ userId: user.id, err: (error as Error).message }, 'Failed to sync user positions');
  }
}
