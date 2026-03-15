import { Router } from 'express';
import { z } from 'zod';
import { Address, JettonMaster, JettonWallet, TonClient } from '@ton/ton';
import { authMiddleware } from '../middleware/auth.js';
import {
  appendWithdrawalProgress,
  bindWallet,
  completeOnboarding,
  createDepositIntent,
  createWithdrawalRequest,
  getDepositStatusByIntent,
  getAppProfileByUserId,
  getFeedByUser,
  getPortfolioByUser,
  getPositionsByUser,
  getWithdrawalStatusById,
  getUserIdByTelegramId,
  setUserPause,
  updateWithdrawalRequest,
  updateDepositStatus,
  updateRiskProfile,
  upsertUser
} from '../../db/repository.js';
import { ensureUserTradeWallet } from '../../services/wallets/tradeWallets.js';
import { withdrawUsdtFromUserTradeWallet } from '../../services/wallets/userTradeWalletWithdrawals.js';
import { getConfig } from '../../config.js';
import { validateTelegramInitData } from '../../utils/telegramAuth.js';
import { settleDepositFromTon } from '../../services/deposits/settlement.js';
import { getTonPriceForDepositQuote, getTonPriceForQuote, getTonPriceSnapshot } from '../../services/market/tonPriceCache.js';
import { estimateTonForUsdtSwap } from '../../services/swaps/stonTonToUsdt.js';
import { logger } from '../../logger.js';
import { getTradeWalletBalancesForUser } from '../../services/wallets/tradeBalances.js';
import { MIN_DEPOSIT_USDT } from '../../constants/deposits.js';

const authSchema = z.object({ init_data: z.string().min(10) });
const bindWalletSchema = z.object({ wallet_address: z.string().min(10), signature: z.string().optional() });
const riskSchema = z.object({
  max_loss_pct: z.number().min(5).max(50),
  allowed_assets: z.array(z.enum(['crypto', 'gold', 'oil', 'stocks', 'forex'])).min(1)
});
const depositIntentSchema = z.object({
  amount_usdt: z.number().min(MIN_DEPOSIT_USDT, `Minimum deposit is ${MIN_DEPOSIT_USDT} USDT.`),
  wallet_address: z.string().min(10)
});
const depositQuoteSchema = z.object({
  amount_usdt: z.number().min(MIN_DEPOSIT_USDT, `Minimum deposit is ${MIN_DEPOSIT_USDT} USDT.`)
});
const depositSubmittedSchema = z.object({
  intent_id: z.string().uuid(),
  quoted_ton_amount: z.number().positive().optional(),
  quoted_ton_amount_nano: z.string().regex(/^\d+$/).optional(),
  tx_hash: z.string().optional()
});
const withdrawSchema = z.object({
  amount_usdt: z.number().min(0.11, 'Withdrawal amount must be greater than 0.10 USDT.'),
  destination_wallet: z.string().min(10)
});
const withdrawStatusParamsSchema = z.object({
  withdrawalId: z.string().uuid()
});
const onboardingSchema = z.object({
  name: z.string().min(1).max(80),
  wallet_address: z.string().min(10),
  risk_level: z.enum(['conservative', 'balanced', 'aggressive']),
  max_loss_pct: z.number().min(5).max(50),
  allowed_assets: z.array(z.enum(['crypto', 'gold', 'oil', 'stocks', 'forex'])).min(1)
});
const walletTonBalanceQuerySchema = z.object({
  address: z.string().min(10).optional()
});
const tradeHistoryQuerySchema = z.object({
  address: z.string().min(10).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});
const tradeBalanceQuerySchema = z.object({
  address: z.string().min(10).optional()
});

export const v1Router = Router();
const tonClient = new TonClient({
  endpoint: getConfig().TONCENTER_RPC_URL,
  apiKey: getConfig().TONCENTER_API_KEY
});
const settlementInFlight = new Set<string>();
const DEPOSIT_SWAP_FEE_BPS = 80;
const DEPOSIT_TRANSFER_FEE_TON = 0.03;
const DEPOSIT_NETWORK_BUFFER_TON = 0.01;

function normalizeAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: true, urlSafe: true });
}

function toNanoUnits(tonAmount: number): bigint {
  const [wholePart, fractionPart = ''] = tonAmount.toFixed(9).split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart + '000000000').slice(0, 9));
  return whole * 1_000_000_000n + fraction;
}

function fromNanoUnits(nanoAmount: bigint): number {
  return Number(nanoAmount) / 1_000_000_000;
}

function toIsoFromUnix(value: number): string {
  return new Date(value * 1000).toISOString();
}

const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const JETTON_INTERNAL_TRANSFER_OP = 0x178d4519;
const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

function parseJettonMessage(message: { body: { beginParse: () => any } }): {
  amount: bigint;
  counterparty: string | null;
} | null {
  try {
    const body = message.body.beginParse();
    if (body.remainingBits < 32) {
      return null;
    }

    const op = body.loadUint(32);
    if (
      op !== JETTON_TRANSFER_OP &&
      op !== JETTON_INTERNAL_TRANSFER_OP &&
      op !== JETTON_TRANSFER_NOTIFICATION_OP
    ) {
      return null;
    }

    if (body.remainingBits < 64) {
      return null;
    }
    body.loadUintBig(64); // query_id

    const amount = body.loadCoins();
    let counterparty: string | null = null;

    if (op === JETTON_TRANSFER_OP || op === JETTON_INTERNAL_TRANSFER_OP || op === JETTON_TRANSFER_NOTIFICATION_OP) {
      const addr = body.loadAddressAny();
      if (addr && typeof addr.toString === 'function') {
        counterparty = normalizeAddress(addr.toString());
      }
    }

    return { amount, counterparty };
  } catch {
    return null;
  }
}

async function verifyIncomingTonPayment(params: {
  fromWalletAddress: string;
  minTonAmount: number;
  notBeforeIso: string;
}): Promise<boolean> {
  const agentAddress = Address.parse(getConfig().AGENT_WALLET_ADDRESS);
  const requiredNano = toNanoUnits(params.minTonAmount);
  const notBeforeTs = Math.floor(new Date(params.notBeforeIso).getTime() / 1000) - 120;
  const fromNormalized = normalizeAddress(params.fromWalletAddress);

  const txs = await tonClient.getTransactions(agentAddress, {
    limit: 30,
    archival: true
  });

  for (const tx of txs) {
    if (typeof tx.now === 'number' && tx.now < notBeforeTs) {
      continue;
    }

    const info = tx.inMessage?.info;
    if (!info || info.type !== 'internal') {
      continue;
    }

    const src = info.src?.toString();
    if (!src || normalizeAddress(src) !== fromNormalized) {
      continue;
    }

    if (info.value.coins >= requiredNano) {
      return true;
    }
  }

  return false;
}

async function trySettleDeposit(params: {
  userId: string;
  intentId: string;
  tradeWalletAddress: string;
  fallbackQuotedTonAmount?: number | null;
  depositStatus: {
    wallet_address: string | null;
    amount_usdt: number;
    quoted_ton_amount: number | null;
    created_at: string;
    tx_hash: string | null;
    status: string;
  };
}): Promise<{
  status: 'confirmed' | 'ton_submitted' | 'conversion_pending';
  message: string;
  usdt_tx_hash: string | null;
  swap_reference: string | null;
  settled_usdt_amount: number | null;
}> {
  if (settlementInFlight.has(params.intentId)) {
    return {
      status: params.depositStatus.status === 'conversion_pending' ? 'conversion_pending' : 'ton_submitted',
      message: 'Settlement already in progress.',
      usdt_tx_hash: null,
      swap_reference: null,
      settled_usdt_amount: null
    };
  }

  settlementInFlight.add(params.intentId);

  try {
    if (!params.depositStatus.wallet_address) {
      await updateDepositStatus({
        user_id: params.userId,
        intent_id: params.intentId,
        status: 'conversion_pending'
      });
      return {
        status: 'conversion_pending',
        message: 'Missing source wallet address. Waiting for manual review.',
        usdt_tx_hash: null,
        swap_reference: null,
        settled_usdt_amount: null
      };
    }

    const quotedTonAmount = params.depositStatus.quoted_ton_amount ?? params.fallbackQuotedTonAmount ?? null;
    if (!quotedTonAmount || !Number.isFinite(quotedTonAmount) || quotedTonAmount <= 0) {
      await updateDepositStatus({
        user_id: params.userId,
        intent_id: params.intentId,
        status: 'conversion_pending'
      });
      return {
        status: 'conversion_pending',
        message: 'Quote not found. Waiting for manual settlement.',
        usdt_tx_hash: null,
        swap_reference: null,
        settled_usdt_amount: null
      };
    }

    const minConfirmTon = Number((quotedTonAmount * 0.995).toFixed(9));
    const hasPayment = await verifyIncomingTonPayment({
      fromWalletAddress: params.depositStatus.wallet_address,
      minTonAmount: minConfirmTon,
      notBeforeIso: params.depositStatus.created_at
    });

    if (!hasPayment) {
      await updateDepositStatus({
        user_id: params.userId,
        intent_id: params.intentId,
        status: 'ton_submitted'
      });
      return {
        status: 'ton_submitted',
        message: 'Waiting for TON transfer confirmation.',
        usdt_tx_hash: null,
        swap_reference: null,
        settled_usdt_amount: null
      };
    }

    await updateDepositStatus({
      user_id: params.userId,
      intent_id: params.intentId,
      status: 'conversion_pending'
    });

    const settlement = await settleDepositFromTon({
      userId: params.userId,
      intentId: params.intentId,
      sourceWalletAddress: params.depositStatus.wallet_address,
      targetTradeWalletAddress: params.tradeWalletAddress,
      requestedUsdtAmount: params.depositStatus.amount_usdt,
      quotedTonAmount,
      submissionRef: params.depositStatus.tx_hash ?? undefined
    });

    const finalStatus = settlement.status === 'confirmed' ? 'confirmed' : 'conversion_pending';
    await updateDepositStatus({
      user_id: params.userId,
      intent_id: params.intentId,
      status: finalStatus
    });

    return {
      status: finalStatus,
      message:
        settlement.message ??
        (finalStatus === 'confirmed' ? 'Deposit confirmed.' : 'Conversion in progress.'),
      usdt_tx_hash: settlement.usdt_tx_hash ?? null,
      swap_reference: settlement.swap_reference ?? null,
      settled_usdt_amount: settlement.settled_usdt_amount ?? null
    };
  } catch (error) {
    await updateDepositStatus({
      user_id: params.userId,
      intent_id: params.intentId,
      status: 'conversion_pending'
    });
    return {
      status: 'conversion_pending',
      message: `Settlement pending: ${(error as Error).message}`,
      usdt_tx_hash: null,
      swap_reference: null,
      settled_usdt_amount: null
    };
  } finally {
    settlementInFlight.delete(params.intentId);
  }
}

function quoteTonAmountNano(amountUsdt: number, tonPriceUsd: number): bigint {
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Invalid USDT amount for quote.');
  }
  if (!Number.isFinite(tonPriceUsd) || tonPriceUsd <= 0) {
    throw new Error('Invalid TON price for quote.');
  }

  // Keep quote at nano precision and never round to zero.
  return BigInt(Math.max(1, Math.ceil((amountUsdt / tonPriceUsd) * 1_000_000_000)));
}

async function calculateDepositTonQuote(amountUsdt: number, tonPriceUsd: number): Promise<{
  baseTonNano: bigint;
  swapFeeTonNano: bigint;
  transferFeeTonNano: bigint;
  networkBufferTonNano: bigint;
  feeTonNano: bigint;
  totalTonNano: bigint;
}> {
  const feedBasedBaseTonNano = quoteTonAmountNano(amountUsdt, tonPriceUsd);
  let baseTonNano = feedBasedBaseTonNano;

  try {
    const reverseSwapQuote = await estimateTonForUsdtSwap(amountUsdt);
    if (reverseSwapQuote.offerTonNano > baseTonNano) {
      baseTonNano = reverseSwapQuote.offerTonNano;
    }
  } catch (error) {
    logger.warn(
      { err: (error as Error).message, amount_usdt: amountUsdt },
      'Reverse swap quote unavailable, falling back to feed-based TON quote'
    );
  }

  const swapFeeTonNano = (baseTonNano * BigInt(DEPOSIT_SWAP_FEE_BPS) + 9_999n) / 10_000n;
  const transferFeeTonNano = toNanoUnits(DEPOSIT_TRANSFER_FEE_TON);
  const networkBufferTonNano = toNanoUnits(DEPOSIT_NETWORK_BUFFER_TON);
  const feeTonNano = swapFeeTonNano + transferFeeTonNano + networkBufferTonNano;
  const totalTonNano = baseTonNano + feeTonNano;

  return {
    baseTonNano,
    swapFeeTonNano,
    transferFeeTonNano,
    networkBufferTonNano,
    feeTonNano,
    totalTonNano
  };
}

function requireUserId(req: { auth?: { userId: string | null } }, res: any): string | null {
  const userId = req.auth?.userId ?? null;
  if (!userId) {
    res.status(401).json({ error: 'Onboarding incomplete. Complete onboarding first.' });
    return null;
  }
  return userId;
}

v1Router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ton-capital-agent-backend' });
});

v1Router.post('/auth/telegram', async (req, res) => {
  try {
    const body = authSchema.parse(req.body);
    const identity = validateTelegramInitData(body.init_data, getConfig().TELEGRAM_BOT_TOKEN);
    const userId = await getUserIdByTelegramId(identity.telegram_id);

    res.json({
      user_id: userId,
      access_token: body.init_data,
      telegram_id: identity.telegram_id
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.use(authMiddleware);

v1Router.get('/market/ton-usdt', async (_req, res) => {
  try {
    let snapshot = getTonPriceSnapshot();
    if (!snapshot) {
      await getTonPriceForQuote();
      snapshot = getTonPriceSnapshot();
    }

    if (!snapshot) {
      res.status(503).json({ error: 'TON price unavailable' });
      return;
    }

    res.json(snapshot);
  } catch (error) {
    res.status(503).json({ error: (error as Error).message });
  }
});

v1Router.post('/deposit/quote', async (req, res) => {
  try {
    const body = depositQuoteSchema.parse(req.body);
    const userId = requireUserId(req, res);
    if (!userId) return;

    const tonPriceUsd = await getTonPriceForDepositQuote();
    const quote = await calculateDepositTonQuote(body.amount_usdt, tonPriceUsd);

    res.json({
      quoted_usdt_amount: body.amount_usdt,
      ton_price_usd: tonPriceUsd,
      quoted_ton_base: fromNanoUnits(quote.baseTonNano),
      quoted_ton_base_nano: quote.baseTonNano.toString(),
      quoted_ton_fee: fromNanoUnits(quote.feeTonNano),
      quoted_ton_fee_nano: quote.feeTonNano.toString(),
      quoted_ton_swap_fee: fromNanoUnits(quote.swapFeeTonNano),
      quoted_ton_swap_fee_nano: quote.swapFeeTonNano.toString(),
      quoted_ton_transfer_fee: fromNanoUnits(quote.transferFeeTonNano),
      quoted_ton_transfer_fee_nano: quote.transferFeeTonNano.toString(),
      quoted_ton_network_buffer: fromNanoUnits(quote.networkBufferTonNano),
      quoted_ton_network_buffer_nano: quote.networkBufferTonNano.toString(),
      quoted_ton_amount: fromNanoUnits(quote.totalTonNano),
      quoted_ton_amount_nano: quote.totalTonNano.toString()
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/wallet/ton-balance', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const query = walletTonBalanceQuerySchema.parse(req.query);
    let targetAddress = query.address ?? null;
    if (!targetAddress) {
      const profile = await getAppProfileByUserId(userId);
      targetAddress = profile.wallet_address ?? profile.trade_wallet_address ?? null;
    }

    if (!targetAddress) {
      res.status(400).json({ error: 'No wallet address available for TON balance lookup.' });
      return;
    }

    const parsed = Address.parse(targetAddress);
    const balanceNano = await tonClient.getBalance(parsed);

    res.json({
      address: parsed.toString({ bounceable: true, urlSafe: true }),
      ton_balance: Number(balanceNano) / 1_000_000_000,
      ton_balance_nano: balanceNano.toString()
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/wallet/trade-balances', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const query = tradeBalanceQuerySchema.parse(req.query);
    const balances = await getTradeWalletBalancesForUser({
      userId,
      tradeWalletAddress: query.address ?? null
    });

    res.json(balances);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/wallet/trade-history', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const query = tradeHistoryQuerySchema.parse(req.query);
    let tradeWalletAddress = query.address ?? null;
    if (!tradeWalletAddress) {
      const profile = await getAppProfileByUserId(userId);
      tradeWalletAddress = profile.trade_wallet_address ?? null;
    }
    if (!tradeWalletAddress) {
      tradeWalletAddress = await ensureUserTradeWallet(userId);
    }

    const tradeAddress = Address.parse(tradeWalletAddress);
    const tonPriceUsd = await getTonPriceForQuote();
    const profile = await getAppProfileByUserId(userId);
    const knownUserDestinations = new Set<string>();
    if (profile.wallet_address) {
      knownUserDestinations.add(normalizeAddress(profile.wallet_address));
    }
    const usdtMaster = tonClient.open(JettonMaster.create(Address.parse(getConfig().USDT_JETTON_MASTER)));
    const usdtWalletAddress = await usdtMaster.getWalletAddress(tradeAddress);
    const usdtWalletNormalized = normalizeAddress(usdtWalletAddress.toString());

    const txs = await tonClient.getTransactions(tradeAddress, {
      limit: query.limit,
      archival: true
    });

    const items: Array<{
      id: string;
      tx_hash: string;
      timestamp: string;
      direction: 'deposit' | 'withdrawal';
      asset: 'TON' | 'USDT';
      amount: number;
      counterparty: string | null;
    }> = [];

    const includeHistoryItem = (item: {
      direction: 'deposit' | 'withdrawal';
      asset: 'TON' | 'USDT';
      amount: number;
      counterparty: string | null;
    }) => {
      const counterparty = item.counterparty ? normalizeAddress(item.counterparty) : null;
      const usdValue = item.asset === 'USDT' ? item.amount : item.amount * tonPriceUsd;

      // Only keep real capital movements; hide swap legs/internal churn.
      if (item.direction === 'deposit') {
        if (item.asset === 'USDT') {
          return usdValue >= 1;
        }
        return usdValue >= 1 && !!counterparty && knownUserDestinations.has(counterparty);
      }

      // Withdrawal history should show payouts to user's connected wallet only.
      return item.asset === 'TON' && !!counterparty && knownUserDestinations.has(counterparty);
    };

    for (const tx of txs) {
      const txHash = tx.hash().toString('hex');
      const timestamp = toIsoFromUnix(tx.now);

      const inbound = tx.inMessage?.info;
      if (inbound && inbound.type === 'internal' && inbound.value.coins > 0n) {
        const srcNormalized = inbound.src ? normalizeAddress(inbound.src.toString()) : null;
        const parsedJetton = srcNormalized === usdtWalletNormalized && tx.inMessage
          ? parseJettonMessage(tx.inMessage)
          : null;

        const nextItem = {
          id: `${txHash}:in`,
          tx_hash: txHash,
          timestamp,
          direction: 'deposit' as const,
          asset: (parsedJetton ? 'USDT' : 'TON') as 'USDT' | 'TON',
          amount: parsedJetton ? Number(parsedJetton.amount) / 1_000_000 : fromNanoUnits(inbound.value.coins),
          counterparty:
            parsedJetton?.counterparty ??
            (srcNormalized ?? null)
        };
        if (includeHistoryItem(nextItem)) {
          items.push(nextItem);
        }
      }

      let outIndex = 0;
      for (const [, message] of tx.outMessages) {
        const info = message.info;
        if (!info || info.type !== 'internal' || info.value.coins <= 0n) {
          continue;
        }

        const destNormalized = info.dest ? normalizeAddress(info.dest.toString()) : null;
        const parsedJetton = destNormalized === usdtWalletNormalized
          ? parseJettonMessage(message)
          : null;

        const nextItem = {
          id: `${txHash}:out:${outIndex}`,
          tx_hash: txHash,
          timestamp,
          direction: 'withdrawal' as const,
          asset: (parsedJetton ? 'USDT' : 'TON') as 'USDT' | 'TON',
          amount: parsedJetton ? Number(parsedJetton.amount) / 1_000_000 : fromNanoUnits(info.value.coins),
          counterparty:
            parsedJetton?.counterparty ??
            (destNormalized ?? null)
        };
        if (includeHistoryItem(nextItem)) {
          items.push(nextItem);
        }
        outIndex += 1;
      }
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({
      trade_wallet_address: tradeAddress.toString({ bounceable: true, urlSafe: true }),
      items
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/user/exists', async (req, res) => {
  try {
    res.json({ exists: Boolean(req.auth?.userId) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

v1Router.get('/me', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const data = await getAppProfileByUserId(userId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

v1Router.post('/auth/wallet-bind', async (req, res) => {
  try {
    const body = bindWalletSchema.parse(req.body);
    const userId = requireUserId(req, res);
    if (!userId) return;
    await bindWallet(userId, body.wallet_address);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/portfolio', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const data = await getPortfolioByUser(userId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

v1Router.get('/positions', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const data = await getPositionsByUser(userId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

v1Router.get('/agent-feed', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const data = await getFeedByUser(userId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

v1Router.post('/risk-profile', async (req, res) => {
  try {
    const profile = riskSchema.parse(req.body);
    const userId = requireUserId(req, res);
    if (!userId) return;
    await updateRiskProfile(userId, profile);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.post('/onboarding/complete', async (req, res) => {
  try {
    const body = onboardingSchema.parse(req.body);
    if (!req.auth) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const identity = {
      telegram_id: req.auth.telegramId,
      username: req.auth.username,
      first_name: req.auth.firstName,
      last_name: req.auth.lastName
    };
    const userId = req.auth.userId ?? (await upsertUser(identity));

    await bindWallet(userId, body.wallet_address);
    await updateRiskProfile(userId, {
      max_loss_pct: body.max_loss_pct,
      allowed_assets: body.allowed_assets
    });

    const tradeWalletAddress = await ensureUserTradeWallet(userId);

    await completeOnboarding(userId, {
      name: body.name,
      risk_level: body.risk_level,
      max_loss_pct: body.max_loss_pct,
      allowed_assets: body.allowed_assets,
      wallet_address: body.wallet_address,
      trade_wallet_address: tradeWalletAddress
    });

    res.json({
      success: true,
      trade_wallet_address: tradeWalletAddress
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.post('/deposit/intent', async (req, res) => {
  try {
    const body = depositIntentSchema.parse(req.body);
    const userId = requireUserId(req, res);
    if (!userId) return;
    const tonPriceUsd = await getTonPriceForDepositQuote();
    const quote = await calculateDepositTonQuote(body.amount_usdt, tonPriceUsd);
    const quotedTonAmountNano = quote.totalTonNano;
    const quotedTonAmount = fromNanoUnits(quotedTonAmountNano);
    if (quotedTonAmount <= 0) {
      throw new Error('Invalid TON quote amount.');
    }

    const tradeWalletAddress = await ensureUserTradeWallet(userId);
    const agentWallet = Address.parse(getConfig().AGENT_WALLET_ADDRESS).toString({ bounceable: true, urlSafe: true });
    const jettonMaster = getConfig().USDT_JETTON_MASTER;

    const intent = await createDepositIntent({
      user_id: userId,
      amount_usdt: body.amount_usdt,
      wallet_address: body.wallet_address,
      destination_wallet: agentWallet,
      jetton_master: jettonMaster,
      quoted_ton_amount: quotedTonAmount,
      quoted_ton_price_usd: tonPriceUsd
    });

    await updateDepositStatus({
      user_id: userId,
      intent_id: intent.intent_id,
      status: 'quote_created'
    });

    res.json({
      intent_id: intent.intent_id,
      pay_to_wallet: agentWallet,
      quoted_ton_base: fromNanoUnits(quote.baseTonNano),
      quoted_ton_base_nano: quote.baseTonNano.toString(),
      quoted_ton_fee: fromNanoUnits(quote.feeTonNano),
      quoted_ton_fee_nano: quote.feeTonNano.toString(),
      quoted_ton_swap_fee: fromNanoUnits(quote.swapFeeTonNano),
      quoted_ton_swap_fee_nano: quote.swapFeeTonNano.toString(),
      quoted_ton_transfer_fee: fromNanoUnits(quote.transferFeeTonNano),
      quoted_ton_transfer_fee_nano: quote.transferFeeTonNano.toString(),
      quoted_ton_network_buffer: fromNanoUnits(quote.networkBufferTonNano),
      quoted_ton_network_buffer_nano: quote.networkBufferTonNano.toString(),
      quoted_ton_amount: quotedTonAmount,
      quoted_ton_amount_nano: quotedTonAmountNano.toString(),
      quoted_usdt_amount: body.amount_usdt,
      ton_price_usd: tonPriceUsd,
      trade_wallet_address: tradeWalletAddress
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.post('/deposit/submitted', async (req, res) => {
  try {
    const body = depositSubmittedSchema.parse(req.body);
    const userId = requireUserId(req, res);
    if (!userId) return;
    const tradeWalletAddress = await ensureUserTradeWallet(userId);
    const depositStatus = await getDepositStatusByIntent({
      user_id: userId,
      intent_id: body.intent_id
    });
    if (!depositStatus) {
      res.status(404).json({ error: 'Deposit intent not found.' });
      return;
    }

    await updateDepositStatus({
      user_id: userId,
      intent_id: body.intent_id,
      status: 'ton_submitted',
      tx_hash: body.tx_hash ?? null
    });
    const settlement = await trySettleDeposit({
      userId,
      intentId: body.intent_id,
      tradeWalletAddress,
      fallbackQuotedTonAmount: body.quoted_ton_amount_nano
        ? fromNanoUnits(BigInt(body.quoted_ton_amount_nano))
        : (body.quoted_ton_amount ?? null),
      depositStatus
    });

    res.json({
      success: true,
      status: settlement.status,
      message: settlement.message,
      trade_wallet_address: tradeWalletAddress,
      usdt_tx_hash: settlement.usdt_tx_hash,
      swap_reference: settlement.swap_reference,
      settled_usdt_amount: settlement.settled_usdt_amount
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/deposit/status/:intentId', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const intentId = z.string().uuid().parse(req.params.intentId);
    const status = await getDepositStatusByIntent({
      user_id: userId,
      intent_id: intentId
    });

    if (!status) {
      res.status(404).json({ error: 'Deposit intent not found.' });
      return;
    }

    if (status.status === 'ton_submitted' || status.status === 'conversion_pending') {
      const tradeWalletAddress = await ensureUserTradeWallet(userId);
      await trySettleDeposit({
        userId,
        intentId,
        tradeWalletAddress,
        fallbackQuotedTonAmount: null,
        depositStatus: status
      });
      const refreshed = await getDepositStatusByIntent({
        user_id: userId,
        intent_id: intentId
      });
      if (refreshed) {
        res.json(refreshed);
        return;
      }
    }

    res.json(status);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.post('/withdraw/request', async (req, res) => {
  try {
    const body = withdrawSchema.parse(req.body);
    const userId = requireUserId(req, res);
    if (!userId) return;
    const normalizedDestination = normalizeAddress(body.destination_wallet);

    const created = await createWithdrawalRequest({
      user_id: userId,
      amount_usdt: body.amount_usdt,
      destination_wallet: normalizedDestination
    });

    await updateWithdrawalRequest({
      user_id: userId,
      withdrawal_id: created.id,
      status: 'processing'
    });
    await appendWithdrawalProgress({
      user_id: userId,
      withdrawal_id: created.id,
      stage: 'processing_started',
      message: 'Withdrawal processing started.'
    });

    void (async () => {
      try {
        const transfer = await withdrawUsdtFromUserTradeWallet({
          userId,
          amountUsdt: body.amount_usdt,
          destinationWallet: normalizedDestination,
          onProgress: async (event) => {
            await appendWithdrawalProgress({
              user_id: userId,
              withdrawal_id: created.id,
              stage: event.stage,
              message: event.message,
              tx_hash: event.tx_hash,
              details: event.details
            });
          }
        });

        await updateWithdrawalRequest({
          user_id: userId,
          withdrawal_id: created.id,
          status: 'processed',
          tx_hash: transfer.tx_hash
        });
        await appendWithdrawalProgress({
          user_id: userId,
          withdrawal_id: created.id,
          stage: 'completed',
          message: 'Withdrawal completed successfully.',
          tx_hash: transfer.tx_hash
        });
      } catch (error) {
        try {
          await updateWithdrawalRequest({
            user_id: userId,
            withdrawal_id: created.id,
            status: 'failed'
          });
          await appendWithdrawalProgress({
            user_id: userId,
            withdrawal_id: created.id,
            stage: 'failed',
            message: (error as Error).message
          });
        } catch {
          // best effort; status endpoint may still show processing if DB update fails.
        }
      }
    })();

    res.status(202).json({
      success: true,
      status: 'processing',
      withdrawal_id: created.id,
      tx_hash: null,
      amount_usdt: created.amount_usdt,
      destination_wallet: created.destination_wallet,
      created_at: created.created_at,
      processed_at: created.processed_at,
      progress: created.progress
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.get('/withdraw/status/:withdrawalId', async (req, res) => {
  try {
    const params = withdrawStatusParamsSchema.parse(req.params);
    const userId = requireUserId(req, res);
    if (!userId) return;

    const status = await getWithdrawalStatusById({
      user_id: userId,
      withdrawal_id: params.withdrawalId
    });

    if (!status) {
      res.status(404).json({ error: 'Withdrawal request not found.' });
      return;
    }

    res.json({
      withdrawal_id: status.id,
      amount_usdt: status.amount_usdt,
      destination_wallet: status.destination_wallet,
      tx_hash: status.tx_hash,
      status: status.status,
      created_at: status.created_at,
      processed_at: status.processed_at,
      progress: status.progress
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.post('/user/pause', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    await setUserPause(userId, true);
    res.json({ success: true, paused: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

v1Router.post('/user/resume', async (req, res) => {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    await setUserPause(userId, false);
    res.json({ success: true, paused: false });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
