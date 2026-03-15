import type { MarketBriefing } from '../../types/ai.js';
import { logger } from '../../logger.js';
import { getFearGreed } from './fearGreed.js';
import { getNewsFeed } from './news.js';
import { getStormPrices } from './oracle.js';
import { getStormMarketContext } from './stormContext.js';
import { getWhaleFlows } from './whale.js';

async function withFallback<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.warn({ err: (error as Error).message, source: label }, 'Data source failed, using fallback');
    return fallback;
  }
}

export async function fetchMarketBriefing(): Promise<MarketBriefing> {
  const [prices, market_context, news, fearGreed, whaleFlows] = await Promise.all([
    withFallback('oracle', getStormPrices, {}),
    withFallback('storm_market_context', getStormMarketContext, {}),
    withFallback('news', getNewsFeed, []),
    withFallback('fear_greed', getFearGreed, { value: 50, classification: 'Neutral' }),
    withFallback('whale_flows', getWhaleFlows, [])
  ]);

  return {
    timestamp: new Date().toISOString(),
    prices,
    market_context,
    news,
    fearGreed,
    whaleFlows
  };
}
