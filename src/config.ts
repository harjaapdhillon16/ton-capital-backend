import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default('info'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_API_URL: z.string().url().default('https://api.deepseek.com/chat/completions'),
  DEEPSEEK_MODEL: z.string().default('deepseek-reasoner'),
  TONCENTER_RPC_URL: z.string().url(),
  TONCENTER_API_KEY: z.string().optional(),
  STORM_API_URL: z.string().url(),
  ORACLE_URL: z.string().url(),
  STORM_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  DEPOSIT_SETTLEMENT_MODE: z.enum(['ston_auto', 'swap_webhook', 'treasury_usdt']).default('ston_auto'),
  TON_USDT_SWAP_WEBHOOK_URL: optionalUrl,
  TON_USDT_SWAP_WEBHOOK_TOKEN: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  USDT_JETTON_MASTER: z.string().min(1),
  AGENT_WALLET_ADDRESS: z.string().min(1),
  AGENT_WALLET_MNEMONIC: z.string().min(1),
  USER_TRADE_WALLET_VERSION: z.enum(['v4']).default('v4'),
  COINGECKO_API_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  CRYPTOPANIC_API_KEY: z.string().optional(),
  NEWS_API_KEY: z.string().optional(),
  FEAR_GREED_URL: z.string().url().default('https://api.alternative.me/fng/')
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid env: ${result.error.message}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}
