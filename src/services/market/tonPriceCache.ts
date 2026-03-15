import { getConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { getStormPrices } from '../data/oracle.js';

type PriceSource = 'storm' | 'coingecko';

type TonPriceState = {
  price_usdt: number;
  source: PriceSource;
  updated_at: string;
  updated_at_ms: number;
};

let state: TonPriceState | null = null;
let refreshPromise: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function normalizeTonPriceCandidate(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }

  // Some APIs may occasionally return nano-scaled values.
  const maybeScaled = raw > 1_000_000 ? raw / 1_000_000_000 : raw;
  if (maybeScaled <= 0 || maybeScaled > 1_000_000) {
    return null;
  }

  return maybeScaled;
}

function setState(price: number, source: PriceSource): void {
  state = {
    price_usdt: price,
    source,
    updated_at: new Date().toISOString(),
    updated_at_ms: Date.now()
  };
}

async function fetchFromStorm(): Promise<number | null> {
  try {
    const prices = await getStormPrices();
    return normalizeTonPriceCandidate(prices.TON ?? prices.TONCOIN);
  } catch {
    return null;
  }
}

async function fetchFromCoinGecko(): Promise<number | null> {
  try {
    const base = getConfig().COINGECKO_API_URL.replace(/\/+$/, '');
    const response = await fetch(`${base}/simple/price?ids=the-open-network&vs_currencies=usd`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      return null;
    }
    const json = (await response.json()) as { 'the-open-network'?: { usd?: number } };
    return normalizeTonPriceCandidate(json['the-open-network']?.usd ?? 0);
  } catch {
    return null;
  }
}

async function fetchCoinGeckoOrThrow(): Promise<number> {
  const coingecko = await fetchFromCoinGecko();
  if (coingecko === null) {
    throw new Error('CoinGecko TON price unavailable.');
  }
  return coingecko;
}

export async function refreshTonPriceNow(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const storm = await fetchFromStorm();
    if (storm !== null) {
      setState(storm, 'storm');
      return;
    }

    const coingecko = await fetchFromCoinGecko();
    if (coingecko !== null) {
      setState(coingecko, 'coingecko');
      return;
    }

    throw new Error('Unable to refresh TON price from storm/coingecko.');
  })()
    .catch((error) => {
      logger.warn({ err: (error as Error).message }, 'TON price refresh failed');
      throw error;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

export async function startTonPricePolling(intervalMs = 1000): Promise<void> {
  if (pollTimer) {
    return;
  }

  try {
    await refreshTonPriceNow();
  } catch {
    // Keep service alive; periodic poller may recover.
  }

  pollTimer = setInterval(() => {
    void refreshTonPriceNow();
  }, intervalMs);
}

export function getTonPriceSnapshot(): Omit<TonPriceState, 'updated_at_ms'> | null {
  if (!state) {
    return null;
  }
  return {
    price_usdt: state.price_usdt,
    source: state.source,
    updated_at: state.updated_at
  };
}

export async function getTonPriceForQuote(maxStalenessMs = 5000): Promise<number> {
  const now = Date.now();
  if (state && now - state.updated_at_ms <= maxStalenessMs) {
    return state.price_usdt;
  }

  await refreshTonPriceNow();
  if (!state) {
    throw new Error('TON price unavailable.');
  }

  return state.price_usdt;
}

export async function getTonPriceForDepositQuote(maxStalenessMs = 8000): Promise<number> {
  const now = Date.now();
  if (state && now - state.updated_at_ms <= maxStalenessMs) {
    return state.price_usdt;
  }

  const [coingecko, storm] = await Promise.all([fetchFromCoinGecko(), fetchFromStorm()]);
  const candidates = [
    { source: 'coingecko' as const, price: coingecko },
    { source: 'storm' as const, price: storm }
  ].filter((entry): entry is { source: PriceSource; price: number } => entry.price !== null);

  if (candidates.length > 0) {
    // Use the lower valid TON/USD price to avoid under-quoting TON needed for target USDT.
    const selected = candidates.reduce((min, current) => (current.price < min.price ? current : min));

    if (candidates.length === 2) {
      const a = candidates[0]!;
      const b = candidates[1]!;
      const spreadPct = (Math.abs(a.price - b.price) / Math.min(a.price, b.price)) * 100;
      if (spreadPct >= 5) {
        logger.warn(
          {
            coingecko_price_usd: coingecko,
            storm_price_usd: storm,
            spread_pct: Number(spreadPct.toFixed(2)),
            selected_source: selected.source,
            selected_price_usd: selected.price
          },
          'TON price feed spread is high; using conservative deposit quote'
        );
      }
    }

    setState(selected.price, selected.source);
    return selected.price;
  }

  // fallback keeps service working if both fresh fetches are unavailable
  return getTonPriceForQuote(maxStalenessMs);
}
