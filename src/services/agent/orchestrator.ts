import { v4 as uuidv4 } from 'uuid';
import type { MvpAsset } from '../../constants/trading.js';
import { logger } from '../../logger.js';
import { fetchMarketBriefing } from '../data/index.js';
import { analyzeWithDeepSeek } from '../ai/deepseek.js';
import { checkRisk } from '../risk/filter.js';
import { StormExecutionService } from '../execution/storm.js';
import { syncUserCapitalState, syncUserPositions } from './stateSync.js';
import { sendTradeNotification } from '../notify/telegram.js';
import {
  acquireAgentLock,
  completeAgentRun,
  createAgentRun,
  getActiveUsers,
  getSystemControls,
  hasTradeByIdempotency,
  insertBriefing,
  insertNotification,
  insertTrade,
  releaseAgentLock
} from '../../db/repository.js';
import { makeIdempotencyKey } from '../../utils/idempotency.js';

const LOCK_NAME = 'agent_loop';
const LOCK_TTL_SECONDS = 14 * 60;

function resolveMarkPrice(briefing: Awaited<ReturnType<typeof fetchMarketBriefing>>, asset: string): number {
  const normalized = asset.toUpperCase();
  const contextAsset =
    normalized === 'XAU' ? 'XAUUSD' : normalized;
  const byContext = briefing.market_context?.[contextAsset as MvpAsset]?.mark_price;
  const byPrices = briefing.prices[contextAsset] ?? briefing.prices[normalized];
  return Number(byContext ?? byPrices ?? 0);
}

export class AgentOrchestrator {
  private readonly stormExecution = new StormExecutionService();

  async runCycle(trigger: 'startup' | 'schedule' | 'manual' = 'schedule'): Promise<void> {
    const runId = uuidv4();

    const locked = await acquireAgentLock(LOCK_NAME, runId, LOCK_TTL_SECONDS);
    if (!locked) {
      logger.warn({ runId }, 'Agent loop skipped because another run is active');
      return;
    }

    await createAgentRun(runId);

    try {
      logger.info({ runId, trigger }, 'Agent loop started');
      const controls = await getSystemControls();
      if (!controls.trading_enabled) {
        logger.warn({ runId }, 'Trading disabled by global kill switch');
        await completeAgentRun(runId, 'skipped', 'Global kill switch enabled');
        return;
      }

      const briefing = await fetchMarketBriefing();
      const decisions = await analyzeWithDeepSeek(briefing);
      await insertBriefing(runId, briefing, decisions);

      const users = await getActiveUsers();
      let globalExposureThisRun = 0;

      for (const rawUser of users) {
        let user = await syncUserCapitalState(rawUser);
        await syncUserPositions({
          user,
          briefing,
          execution: this.stormExecution
        });

        for (const decision of decisions) {
          if (decision.action === 'HOLD') {
            continue;
          }

          const idempotencyKey = makeIdempotencyKey(runId, user.id, decision);

          if (await hasTradeByIdempotency(idempotencyKey)) {
            logger.info({ runId, userId: user.id, asset: decision.asset }, 'Skipping duplicate idempotency key');
            continue;
          }

          const market = briefing.market_context?.[decision.asset as MvpAsset] ?? null;
          const risk = checkRisk({
            user,
            decision,
            accountUsdt: user.equity_usdt,
            market
          });
          if (!risk.allowed) {
            await insertTrade({
              user_id: user.id,
              run_id: runId,
              idempotency_key: idempotencyKey,
              asset: decision.asset,
              action: decision.action,
              amount_usdt: 0,
              position_pct: 0,
              stop_loss_pct: decision.stop_loss_pct,
              thesis: decision.thesis,
              invalidation: decision.invalidation,
              explanation: decision.explanation_for_user,
              status: 'risk_rejected',
              failure_reason: risk.reason,
              conviction_score: decision.conviction_score,
              risk_reward: decision.risk_reward,
              take_profit_pct: decision.take_profit_pct,
              rejection_category: risk.rejection_category
            });
            continue;
          }

          const amountUsdt = Math.max(
            0,
            Number(((user.equity_usdt * risk.adjusted_position_pct) / 100).toFixed(6))
          );

          if ((decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') && amountUsdt <= 0) {
            await insertTrade({
              user_id: user.id,
              run_id: runId,
              idempotency_key: idempotencyKey,
              asset: decision.asset,
              action: decision.action,
              amount_usdt: amountUsdt,
              position_pct: risk.adjusted_position_pct,
              stop_loss_pct: decision.stop_loss_pct,
              thesis: decision.thesis,
              invalidation: decision.invalidation,
              explanation: decision.explanation_for_user,
              status: 'risk_rejected',
              failure_reason: 'Computed order amount is zero after sizing.',
              conviction_score: decision.conviction_score,
              risk_reward: decision.risk_reward,
              take_profit_pct: decision.take_profit_pct,
              rejection_category: 'readiness'
            });
            continue;
          }

          if (
            controls.launch_cap_enabled &&
            decision.action !== 'CLOSE' &&
            globalExposureThisRun + amountUsdt > controls.max_global_exposure_usdt
          ) {
            await insertTrade({
              user_id: user.id,
              run_id: runId,
              idempotency_key: idempotencyKey,
              asset: decision.asset,
              action: decision.action,
              amount_usdt: amountUsdt,
              position_pct: risk.adjusted_position_pct,
              stop_loss_pct: decision.stop_loss_pct,
              thesis: decision.thesis,
              invalidation: decision.invalidation,
              explanation: decision.explanation_for_user,
              status: 'risk_rejected',
              failure_reason: 'Global exposure cap reached',
              conviction_score: decision.conviction_score,
              risk_reward: decision.risk_reward,
              take_profit_pct: decision.take_profit_pct,
              rejection_category: 'guardrail'
            });
            continue;
          }

          const markPrice = resolveMarkPrice(briefing, decision.asset);
          const execution = await this.stormExecution.executeDecision({
            user,
            decision,
            amountUsdt,
            leverage: risk.adjusted_leverage,
            idempotencyKey,
            markPrice
          });

          if (execution.status === 'executed' && decision.action !== 'CLOSE') {
            globalExposureThisRun += amountUsdt;
          }

          await insertTrade({
            user_id: user.id,
            run_id: runId,
            idempotency_key: idempotencyKey,
            asset: decision.asset,
            action: decision.action,
            amount_usdt: amountUsdt,
            position_pct: risk.adjusted_position_pct,
            stop_loss_pct: decision.stop_loss_pct,
            thesis: decision.thesis,
            invalidation: decision.invalidation,
            explanation: decision.explanation_for_user,
            status: execution.status,
            external_id: execution.external_id,
            tx_hash: execution.tx_hash,
            failure_reason: execution.reason,
            conviction_score: decision.conviction_score,
            risk_reward: decision.risk_reward,
            take_profit_pct: decision.take_profit_pct,
            order_type: execution.order_type,
            stop_trigger_price: execution.stop_trigger_price,
            take_trigger_price: execution.take_trigger_price,
            execution_meta: execution.execution_meta
          });

          if (execution.status === 'executed') {
            try {
              await sendTradeNotification(user.telegram_id, {
                asset: decision.asset,
                action: decision.action,
                position_pct: risk.adjusted_position_pct,
                stop_loss_pct: decision.stop_loss_pct,
                thesis: decision.thesis,
                invalidation: decision.invalidation,
                explanation_for_user: decision.explanation_for_user,
                balance_usdt: user.equity_usdt
              });

              await insertNotification({
                user_id: user.id,
                run_id: runId,
                channel: 'telegram',
                payload: {
                  asset: decision.asset,
                  action: decision.action,
                  amount_usdt: amountUsdt,
                  tx_hash: execution.tx_hash
                },
                status: 'sent'
              });
            } catch (error) {
              await insertNotification({
                user_id: user.id,
                run_id: runId,
                channel: 'telegram',
                payload: {
                  asset: decision.asset,
                  action: decision.action,
                  amount_usdt: amountUsdt,
                  tx_hash: execution.tx_hash
                },
                status: 'failed',
                error_message: (error as Error).message
              });
            }
          }
        }

        user = await syncUserCapitalState(user);
        await syncUserPositions({
          user,
          briefing,
          execution: this.stormExecution
        });
      }

      await completeAgentRun(runId, 'completed');
      logger.info({ runId }, 'Agent loop completed');
    } catch (error) {
      logger.error({ runId, err: (error as Error).message }, 'Agent loop failed');
      await completeAgentRun(runId, 'failed', (error as Error).message);
    } finally {
      await releaseAgentLock(LOCK_NAME, runId);
    }
  }
}
