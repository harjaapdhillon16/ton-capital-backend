import { ATR_PERIOD, MVP_ASSETS } from '../../constants/trading.js';
import { getConfig } from '../../config.js';
import type { MvpAsset } from '../../constants/trading.js';
import type { StormAssetContext } from '../../types/ai.js';

type Candle = {
  high: number;
  low: number;
  close: number;
  open: number;
};

function makeUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function parsePriceWithOptionalScale(value: unknown): number {
  const parsed = toNumber(value, 0);
  if (parsed > 1_000_000) {
    return parsed / 1_000_000_000;
  }
  return parsed;
}

function normalizeCandle(input: unknown): Candle | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const row = input as Record<string, unknown>;
  const open = parsePriceWithOptionalScale(row.open);
  const high = parsePriceWithOptionalScale(row.high);
  const low = parsePriceWithOptionalScale(row.low);
  const close = parsePriceWithOptionalScale(row.close);

  if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  return { open, high, low, close };
}

function calculateAtrPct(candles: Candle[]): number {
  if (candles.length < ATR_PERIOD + 1) {
    return 0;
  }

  const recent = candles.slice(-(ATR_PERIOD + 1));
  let trSum = 0;
  for (let idx = 1; idx < recent.length; idx += 1) {
    const current = recent[idx];
    const previous = recent[idx - 1];
    if (!current || !previous) {
      continue;
    }

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trSum += trueRange;
  }

  const atr = trSum / ATR_PERIOD;
  const lastClose = recent[recent.length - 1]?.close ?? 0;
  if (lastClose <= 0) {
    return 0;
  }

  return Number(((atr / lastClose) * 100).toFixed(4));
}

function deriveVolatilityRegime(atrPct: number): 'low' | 'normal' | 'high' {
  if (atrPct >= 4) {
    return 'high';
  }
  if (atrPct <= 1.2) {
    return 'low';
  }
  return 'normal';
}

function deriveCrowdingBias(longRatio: number): 'crowded_long' | 'crowded_short' | 'balanced' {
  if (longRatio >= 0.62) {
    return 'crowded_long';
  }
  if (longRatio <= 0.38) {
    return 'crowded_short';
  }
  return 'balanced';
}

async function fetchMarketInfo(asset: MvpAsset): Promise<Record<string, unknown>> {
  const base = getConfig().STORM_API_URL;
  const response = await fetch(makeUrl(base, `/markets/${asset}`), {
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Storm market ${asset} request failed: ${response.status}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

async function fetchCandles(asset: MvpAsset): Promise<Candle[]> {
  const base = getConfig().STORM_API_URL;
  const response = await fetch(makeUrl(base, `/candles/${asset}?interval=1D&limit=40`), {
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Storm candles ${asset} request failed: ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.map(normalizeCandle).filter((value): value is Candle => value !== null);
}

async function fetchAssetContext(asset: MvpAsset): Promise<StormAssetContext | null> {
  try {
    const [market, candles] = await Promise.all([fetchMarketInfo(asset), fetchCandles(asset)]);
    const markPrice = parsePriceWithOptionalScale(market.markPrice ?? market.mark_price ?? market.price);
    const indexPrice = parsePriceWithOptionalScale(market.indexPrice ?? market.index_price ?? markPrice);

    if (!Number.isFinite(markPrice) || markPrice <= 0) {
      return null;
    }

    const fundingRate = parsePriceWithOptionalScale(market.fundingRate ?? market.funding_rate);
    const openInterest = toNumber(market.openInterest ?? market.open_interest, 0);
    const longRatioRaw = toNumber(market.longRatio ?? market.long_ratio, 0.5);
    const longRatio = longRatioRaw > 1 ? longRatioRaw / 100 : longRatioRaw;

    const atrPct = calculateAtrPct(candles);
    const latestClose = candles[candles.length - 1]?.close ?? markPrice;
    const priorClose = candles[candles.length - 2]?.close ?? latestClose;
    const dailyChangePct =
      priorClose > 0 ? Number((((latestClose - priorClose) / priorClose) * 100).toFixed(4)) : 0;

    return {
      asset,
      mark_price: markPrice,
      index_price: indexPrice,
      funding_rate: fundingRate,
      open_interest: openInterest,
      long_ratio: longRatio,
      atr_pct: atrPct,
      crowding_bias: deriveCrowdingBias(longRatio),
      volatility_regime: deriveVolatilityRegime(atrPct),
      daily_change_pct: dailyChangePct,
      candles_count: candles.length
    };
  } catch {
    return null;
  }
}

export async function getStormMarketContext(): Promise<Partial<Record<MvpAsset, StormAssetContext>>> {
  const entries = await Promise.all(MVP_ASSETS.map(async (asset) => [asset, await fetchAssetContext(asset)] as const));

  return entries.reduce<Partial<Record<MvpAsset, StormAssetContext>>>((acc, [asset, value]) => {
    if (value) {
      acc[asset] = value;
    }
    return acc;
  }, {});
}
