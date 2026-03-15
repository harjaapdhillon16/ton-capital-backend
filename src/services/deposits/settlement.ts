import { getConfig } from '../../config.js';
import { disburseUsdtFromTreasury } from '../wallets/usdtTreasury.js';
import { getTonPriceForQuote } from '../market/tonPriceCache.js';
import { executeTonToUsdtSwap } from '../swaps/stonTonToUsdt.js';
import { sponsorDepositGas } from '../wallets/gasSponsor.js';
import { DEPOSIT_FEE_RESERVE_USDT } from '../../constants/deposits.js';

export type SettleDepositFromTonInput = {
  userId: string;
  intentId: string;
  sourceWalletAddress: string;
  targetTradeWalletAddress: string;
  requestedUsdtAmount: number;
  quotedTonAmount: number;
  submissionRef?: string;
};

export type SettleDepositFromTonResult = {
  status: 'confirmed' | 'conversion_pending';
  message?: string;
  usdt_tx_hash?: string;
  swap_reference?: string;
  settled_usdt_amount?: number;
};

const feeReserveSentByIntent = new Set<string>();

type DepositSettlementAllocation = {
  feeReserveUsdt: number;
  feeReserveTon: number;
  swapTargetUsdt: number;
  swapTonAmount: number;
};

type SwapWebhookResponse = {
  status?: string;
  message?: string;
  usdt_tx_hash?: string;
  swap_reference?: string;
};

function roundUsdt(value: number): number {
  return Number(value.toFixed(6));
}

function roundTon(value: number): number {
  return Number(value.toFixed(9));
}

function buildAllocation(input: SettleDepositFromTonInput, tonPriceUsd: number): DepositSettlementAllocation {
  if (!Number.isFinite(tonPriceUsd) || tonPriceUsd <= 0) {
    throw new Error('Invalid TON price for deposit settlement.');
  }

  const feeReserveTonRaw = DEPOSIT_FEE_RESERVE_USDT / tonPriceUsd;
  const feeReserveTon = roundTon(Math.min(Math.max(feeReserveTonRaw, 0), Math.max(input.quotedTonAmount, 0)));
  const swapTonAmount = roundTon(Math.max(input.quotedTonAmount - feeReserveTon, 0));
  const swapTargetUsdt = roundUsdt(Math.max(input.requestedUsdtAmount - DEPOSIT_FEE_RESERVE_USDT, 0));

  return {
    feeReserveUsdt: DEPOSIT_FEE_RESERVE_USDT,
    feeReserveTon,
    swapTargetUsdt,
    swapTonAmount
  };
}

async function ensureFeeReserveTransfer(
  input: SettleDepositFromTonInput,
  allocation: DepositSettlementAllocation
): Promise<void> {
  if (feeReserveSentByIntent.has(input.intentId)) {
    return;
  }

  await sponsorDepositGas(input.targetTradeWalletAddress, allocation.feeReserveTon);
  feeReserveSentByIntent.add(input.intentId);
}

async function settleWithSwapWebhook(
  input: SettleDepositFromTonInput,
  allocation: DepositSettlementAllocation
): Promise<SettleDepositFromTonResult> {
  const cfg = getConfig();
  if (!cfg.TON_USDT_SWAP_WEBHOOK_URL) {
    return {
      status: 'conversion_pending',
      message: 'Swap webhook not configured. Conversion queued for manual settlement.'
    };
  }

  const response = await fetch(cfg.TON_USDT_SWAP_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.TON_USDT_SWAP_WEBHOOK_TOKEN
        ? {
            Authorization: `Bearer ${cfg.TON_USDT_SWAP_WEBHOOK_TOKEN}`
          }
        : {})
    },
    body: JSON.stringify({
      user_id: input.userId,
      intent_id: input.intentId,
      from_wallet: input.sourceWalletAddress,
      to_trade_wallet: input.targetTradeWalletAddress,
      ton_amount: allocation.swapTonAmount,
      usdt_amount: allocation.swapTargetUsdt,
      ton_amount_total: input.quotedTonAmount,
      deposit_usdt_amount: input.requestedUsdtAmount,
      fee_reserve_usdt: allocation.feeReserveUsdt,
      fee_reserve_ton: allocation.feeReserveTon,
      submission_ref: input.submissionRef ?? null
    })
  });

  if (!response.ok) {
    throw new Error(`Swap webhook failed: ${response.status}`);
  }

  const payload = (await response.json()) as SwapWebhookResponse;
  const status = String(payload.status ?? '').trim().toLowerCase();

  if (status === 'completed' || status === 'confirmed' || status === 'done') {
    return {
      status: 'confirmed',
      message: payload.message ?? 'TON converted to USDT and credited.',
      usdt_tx_hash: payload.usdt_tx_hash,
      swap_reference: payload.swap_reference
    };
  }

  return {
    status: 'conversion_pending',
    message: payload.message ?? 'TON received. Conversion to USDT is pending.',
    swap_reference: payload.swap_reference
  };
}

async function settleWithTreasuryFallback(input: SettleDepositFromTonInput): Promise<SettleDepositFromTonResult> {
  const tonPriceUsd = await getTonPriceForQuote();
  const allocation = buildAllocation(input, tonPriceUsd);

  await ensureFeeReserveTransfer(input, allocation);
  if (allocation.swapTargetUsdt > 0) {
    await disburseUsdtFromTreasury(input.targetTradeWalletAddress, allocation.swapTargetUsdt);
  }

  return {
    status: 'confirmed',
    message: '2 USDT worth of TON was sent to trade wallet. Remaining USDT sent from treasury fallback mode.',
    settled_usdt_amount: allocation.swapTargetUsdt
  };
}

async function settleWithStonAuto(input: SettleDepositFromTonInput): Promise<SettleDepositFromTonResult> {
  const tonPriceUsd = await getTonPriceForQuote();
  const allocation = buildAllocation(input, tonPriceUsd);

  await ensureFeeReserveTransfer(input, allocation);
  if (allocation.swapTonAmount <= 0 || allocation.swapTargetUsdt <= 0) {
    return {
      status: 'confirmed',
      message: '2 USDT worth of TON was sent to trade wallet.',
      settled_usdt_amount: 0
    };
  }

  const swap = await executeTonToUsdtSwap(allocation.swapTonAmount);
  const swappedUsdtAmount = Number(swap.receivedUsdtUnits) / 1_000_000;
  const settledUsdt = Number(Math.min(swappedUsdtAmount, allocation.swapTargetUsdt).toFixed(6));

  if (!Number.isFinite(settledUsdt) || settledUsdt <= 0) {
    return {
      status: 'conversion_pending',
      message: '2 USDT worth of TON was sent to trade wallet. TON swap completed but USDT output was too low to settle.'
    };
  }

  await disburseUsdtFromTreasury(input.targetTradeWalletAddress, settledUsdt);
  const partial = settledUsdt < allocation.swapTargetUsdt;
  return {
    status: 'confirmed',
    message: partial
      ? `2 USDT worth of TON was sent to trade wallet. Swap filled partially. Settled ${settledUsdt.toFixed(6)} USDT out of ${allocation.swapTargetUsdt.toFixed(6)} USDT.`
      : '2 USDT worth of TON was sent to trade wallet. Remaining TON converted to USDT and credited.',
    settled_usdt_amount: settledUsdt
  };
}

export async function settleDepositFromTon(input: SettleDepositFromTonInput): Promise<SettleDepositFromTonResult> {
  const mode = getConfig().DEPOSIT_SETTLEMENT_MODE;
  let result: SettleDepositFromTonResult;

  if (mode === 'ston_auto') {
    result = await settleWithStonAuto(input);
  } else if (mode === 'treasury_usdt') {
    result = await settleWithTreasuryFallback(input);
  } else {
    const tonPriceUsd = await getTonPriceForQuote();
    const allocation = buildAllocation(input, tonPriceUsd);
    await ensureFeeReserveTransfer(input, allocation);
    result = await settleWithSwapWebhook(input, allocation);
  }

  if (result.status === 'confirmed') {
    feeReserveSentByIntent.delete(input.intentId);
  }
  return result;
}
