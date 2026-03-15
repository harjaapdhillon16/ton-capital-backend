import { getConfig } from '../../config.js';

const PRICE_ENDPOINTS = ['/prices', '/v1/prices', '/v2/prices'];
const FEED_SYMBOLS = ['BTC', 'ETH', 'TON', 'SOL', 'XAUUSD', 'XAU', 'OIL', 'TSLA', 'NVDA', 'AAPL', 'EURUSD', 'GBPUSD'] as const;

function makeUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function normalizePriceMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key.toUpperCase()] = raw;
      continue;
    }

    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        out[key.toUpperCase()] = parsed;
      }
      continue;
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = raw as Record<string, unknown>;
      const nestedRaw =
        nested.price ??
        nested.mark_price ??
        nested.last_price ??
        nested.value;

      if (typeof nestedRaw === 'number' && Number.isFinite(nestedRaw)) {
        out[key.toUpperCase()] = nestedRaw;
      } else if (typeof nestedRaw === 'string') {
        const parsed = Number(nestedRaw);
        if (Number.isFinite(parsed)) {
          out[key.toUpperCase()] = parsed;
        }
      }
    }
  }

  if (out.XAU && !out.XAUUSD) {
    out.XAUUSD = out.XAU;
  }
  if (out.GOLD && !out.XAUUSD) {
    out.XAUUSD = out.GOLD;
  }

  return out;
}

function extractSingleFeedPrice(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const obj = payload as Record<string, unknown>;
  const candidates = [
    obj.price,
    obj.last_price,
    obj.mark_price,
    (obj.result as Record<string, unknown> | undefined)?.price,
    (obj.data as Record<string, unknown> | undefined)?.price,
    (obj.result_message as Record<string, unknown> | undefined)?.price
  ];

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

async function fetchPriceMapByEndpoint(baseUrl: string): Promise<Record<string, number> | null> {
  for (const endpoint of PRICE_ENDPOINTS) {
    const response = await fetch(makeUrl(baseUrl, endpoint), {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      continue;
    }

    const parsed = normalizePriceMap(await response.json());
    if (Object.keys(parsed).length > 0) {
      return parsed;
    }
  }

  return null;
}

async function fetchPriceMapByFeed(baseUrl: string): Promise<Record<string, number> | null> {
  const prices: Record<string, number> = {};

  await Promise.all(
    FEED_SYMBOLS.map(async (symbol) => {
      const feedPaths = [`/feed/${symbol}/last`, `/v1/feed/${symbol}/last`];
      for (const path of feedPaths) {
        const response = await fetch(makeUrl(baseUrl, path), {
          headers: { Accept: 'application/json' }
        });

        if (!response.ok) {
          continue;
        }

        const price = extractSingleFeedPrice(await response.json());
        if (price !== null) {
          prices[symbol] = price;
          return;
        }
      }
    })
  );

  return Object.keys(prices).length > 0 ? prices : null;
}

export async function getStormPrices(): Promise<Record<string, number>> {
  const baseUrl = getConfig().ORACLE_URL;

  const byMap = await fetchPriceMapByEndpoint(baseUrl);
  if (byMap) {
    return byMap;
  }

  const byFeed = await fetchPriceMapByFeed(baseUrl);
  if (byFeed) {
    return byFeed;
  }

  throw new Error(`Storm oracle request failed: no supported price endpoint responded successfully for ${baseUrl}`);
}
