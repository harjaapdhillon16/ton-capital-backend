export const MVP_ASSETS = ['BTC', 'ETH', 'SOL', 'TON', 'NVDA', 'TSLA', 'XAUUSD', 'EURUSD'] as const;

export type MvpAsset = (typeof MVP_ASSETS)[number];

export const MIN_CONVICTION_SCORE = 8;
export const MIN_RISK_REWARD = 2;
export const MAX_POSITION_PCT = 5;
export const MAX_CRYPTO_LEVERAGE = 2;
export const MAX_NON_CRYPTO_LEVERAGE = 1.5;
export const MIN_READY_USDT = 22;
export const BRIEFING_STALE_MS = 20 * 60 * 1000;

export const ATR_PERIOD = 14;
