import { StonApiClient } from '@ston-fi/api';
import { Client, dexFactory } from '@ston-fi/sdk';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, internal, JettonMaster, JettonWallet, SendMode, TonClient, WalletContractV4 } from '@ton/ton';
import { getConfig } from '../../config.js';
import { getUserTradeWalletByUserId } from '../../db/repository.js';
import { getTonPriceForQuote } from '../market/tonPriceCache.js';
import { sponsorDepositGas } from './gasSponsor.js';
import { decryptMnemonic } from './tradeWallets.js';

const TON_ASSET_ADDRESS = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const SWAP_SLIPPAGE_TOLERANCE = '0.01';
const TX_POLL_INTERVAL_MS = 1500;
const TX_POLL_ATTEMPTS = 100;
const GAS_SPONSOR_USDT_EQUIVALENT = 0.05;
const PLATFORM_FEE_USDT_EQUIVALENT = 0.1;
const SWAP_GAS_SAFETY_TON = 0.05;
const queuedByUser = new Map<string, Promise<void>>();

type WithdrawalProgressEvent = {
  stage: string;
  message: string;
  tx_hash?: string | null;
  details?: Record<string, unknown>;
};

type WithdrawalProgressCallback = (event: WithdrawalProgressEvent) => Promise<void> | void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: true, urlSafe: true });
}

function toUsdtUnits(amountUsdt: number): string {
  return BigInt(Math.max(0, Math.round(amountUsdt * 1_000_000))).toString();
}

function toTonNanoUnits(tonAmount: number): bigint {
  const [wholePart, fractionPart = ''] = tonAmount.toFixed(9).split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart + '000000000').slice(0, 9));
  return whole * 1_000_000_000n + fraction;
}

function fromTonNanoUnits(nanoAmount: bigint): number {
  return Number(nanoAmount) / 1_000_000_000;
}

function parseNanoString(value: string | undefined): bigint {
  if (!value) return 0n;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

async function getLatestWalletTxHash(client: TonClient, walletAddress: Address): Promise<string | null> {
  const txs = await client.getTransactions(walletAddress, { limit: 1, archival: true });
  if (!txs[0]) {
    return null;
  }
  return txs[0].hash().toString('hex');
}

async function waitForNewWalletTxHash(params: {
  client: TonClient;
  wallet: WalletContractV4;
  previousHash: string | null;
  previousSeqno: number;
}): Promise<string> {
  const openedWallet = params.client.open(params.wallet);

  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt += 1) {
    await sleep(TX_POLL_INTERVAL_MS);
    const latestHash = await getLatestWalletTxHash(params.client, params.wallet.address);
    const currentSeqno = await openedWallet.getSeqno();
    if (latestHash && latestHash !== params.previousHash && currentSeqno > params.previousSeqno) {
      return latestHash;
    }
  }

  throw new Error('Transfer submitted but transaction hash was not indexed in time.');
}

async function waitForBalanceAtLeast(params: {
  client: TonClient;
  walletAddress: Address;
  minTonNano: bigint;
}): Promise<void> {
  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt += 1) {
    await sleep(TX_POLL_INTERVAL_MS);
    const current = await params.client.getBalance(params.walletAddress);
    if (current >= params.minTonNano) {
      return;
    }
  }

  throw new Error('Sponsored gas was not confirmed in time.');
}

async function resolveUserTradeWalletSigner(userId: string): Promise<{
  client: TonClient;
  stonClient: Client;
  wallet: WalletContractV4;
  secretKey: Buffer;
  sourceWallet: string;
  sourceWalletAddress: Address;
}> {
  const cfg = getConfig();
  const walletRecord = await getUserTradeWalletByUserId(userId);
  if (!walletRecord) {
    throw new Error('Trade wallet custody record not found.');
  }

  const mnemonic = decryptMnemonic({
    encrypted_mnemonic: walletRecord.encrypted_mnemonic,
    encryption_iv: walletRecord.encryption_iv,
    encryption_tag: walletRecord.encryption_tag
  });
  const keyPair = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/).filter(Boolean));

  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });

  const sourceWallet = normalizeAddress(walletRecord.wallet_address);
  const derivedWallet = normalizeAddress(wallet.address.toString());
  if (sourceWallet !== derivedWallet) {
    throw new Error('Trade wallet mnemonic does not match stored trade wallet address.');
  }

  const client = new TonClient({
    endpoint: cfg.TONCENTER_RPC_URL,
    apiKey: cfg.TONCENTER_API_KEY
  });
  const stonClient = new Client({
    endpoint: cfg.TONCENTER_RPC_URL,
    apiKey: cfg.TONCENTER_API_KEY
  });

  return {
    client,
    stonClient,
    wallet,
    secretKey: Buffer.from(keyPair.secretKey),
    sourceWallet,
    sourceWalletAddress: Address.parse(sourceWallet)
  };
}

async function waitForSwapSettlement(params: {
  signer: Awaited<ReturnType<typeof resolveUserTradeWalletSigner>>;
  sourceUsdtWallet: {
    getBalance: () => Promise<bigint>;
  };
  sourceWalletAddress: Address;
  baselineUsdtUnits: bigint;
  baselineTonBeforeSponsor: bigint;
  swapSeqno: number;
  payoutRequiredTonNano: bigint;
}): Promise<bigint> {
  const openedWallet = params.signer.client.open(params.signer.wallet);

  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt += 1) {
    await sleep(TX_POLL_INTERVAL_MS);

    const [currentSeqno, currentUsdt, currentTon] = await Promise.all([
      openedWallet.getSeqno(),
      params.sourceUsdtWallet.getBalance(),
      params.signer.client.getBalance(params.sourceWalletAddress)
    ]);

    const usdtSpent = currentUsdt < params.baselineUsdtUnits;
    const netNewTon = currentTon - params.baselineTonBeforeSponsor;

    if (currentSeqno > params.swapSeqno && usdtSpent && netNewTon >= params.payoutRequiredTonNano) {
      return currentTon;
    }
  }

  throw new Error('USDT->TON swap sent, but settlement did not finalize in time.');
}

async function emitProgress(onProgress: WithdrawalProgressCallback | undefined, event: WithdrawalProgressEvent): Promise<void> {
  if (!onProgress) {
    return;
  }

  try {
    await onProgress(event);
  } catch {
    // Progress channel must not break withdrawal execution.
  }
}

async function withdrawUsdtFromUserTradeWalletInner(params: {
  userId: string;
  amountUsdt: number;
  destinationWallet: string;
  onProgress?: WithdrawalProgressCallback;
}): Promise<{
  tx_hash: string;
  source_wallet: string;
  sponsor_tx_hash: string | null;
  swap_tx_hash: string;
}> {
  if (!Number.isFinite(params.amountUsdt) || params.amountUsdt <= PLATFORM_FEE_USDT_EQUIVALENT) {
    throw new Error(`Withdrawal amount must be greater than ${PLATFORM_FEE_USDT_EQUIVALENT.toFixed(2)} USDT.`);
  }

  await emitProgress(params.onProgress, {
    stage: 'resolve_wallet',
    message: 'Loading user trade wallet and keys.'
  });

  const cfg = getConfig();
  const destinationWallet = normalizeAddress(params.destinationWallet);
  const signer = await resolveUserTradeWalletSigner(params.userId);
  const tonPriceUsd = await getTonPriceForQuote();

  const feeTonNano = toTonNanoUnits(PLATFORM_FEE_USDT_EQUIVALENT / tonPriceUsd);

  const usdtMaster = signer.client.open(JettonMaster.create(Address.parse(cfg.USDT_JETTON_MASTER)));
  const sourceUsdtWalletAddress = await usdtMaster.getWalletAddress(signer.sourceWalletAddress);
  const sourceUsdtWallet = signer.client.open(JettonWallet.create(sourceUsdtWalletAddress));

  const baselineUsdtUnits = await sourceUsdtWallet.getBalance();
  const requestedUsdtUnits = BigInt(toUsdtUnits(params.amountUsdt));
  if (baselineUsdtUnits < requestedUsdtUnits) {
    throw new Error(
      `Insufficient USDT in trade wallet. Available ${(Number(baselineUsdtUnits) / 1_000_000).toFixed(6)} USDT.`
    );
  }

  const api = new StonApiClient();
  const simulation = await api.simulateSwap({
    offerAddress: cfg.USDT_JETTON_MASTER,
    offerUnits: requestedUsdtUnits.toString(),
    askAddress: TON_ASSET_ADDRESS,
    slippageTolerance: SWAP_SLIPPAGE_TOLERANCE
  });

  const usdBasedSponsorNano = toTonNanoUnits(GAS_SPONSOR_USDT_EQUIVALENT / tonPriceUsd);
  const gasBudgetNano = parseNanoString(simulation.gasParams.gasBudget);
  const estimatedGasNano = parseNanoString(simulation.gasParams.estimatedGasConsumption);
  const gasBasedSponsorNano = (gasBudgetNano > estimatedGasNano ? gasBudgetNano : estimatedGasNano) + toTonNanoUnits(SWAP_GAS_SAFETY_TON);
  const sponsorTargetNano = usdBasedSponsorNano > gasBasedSponsorNano ? usdBasedSponsorNano : gasBasedSponsorNano;

  const baselineTonBeforeSponsor = await signer.client.getBalance(signer.sourceWalletAddress);
  const sponsorShortfallNano = sponsorTargetNano > baselineTonBeforeSponsor ? sponsorTargetNano - baselineTonBeforeSponsor : 0n;
  const sponsorTonAmount = fromTonNanoUnits(sponsorShortfallNano);
  const sponsorReturnTonNano = sponsorShortfallNano;
  const agentRecoveryTon = signer.sourceWalletAddress.equals(Address.parse(cfg.AGENT_WALLET_ADDRESS))
    ? 0n
    : (feeTonNano + sponsorReturnTonNano);

  let sponsorTxHash: string | null = null;
  if (sponsorShortfallNano > 0n) {
    await emitProgress(params.onProgress, {
      stage: 'sponsor_gas',
      message: `Sending sponsor gas to trade wallet (${sponsorTonAmount.toFixed(6)} TON).`
    });

    // 1) Sponsor TON from agent wallet only if user trade wallet is short for swap gas.
    sponsorTxHash = await sponsorDepositGas(signer.sourceWallet, sponsorTonAmount);
    await emitProgress(params.onProgress, {
      stage: 'sponsor_submitted',
      message: 'Sponsor gas transaction submitted.',
      tx_hash: sponsorTxHash
    });

    const sponsorConfirmTarget = baselineTonBeforeSponsor + (sponsorShortfallNano * 9n) / 10n;
    await waitForBalanceAtLeast({
      client: signer.client,
      walletAddress: signer.sourceWalletAddress,
      minTonNano: sponsorConfirmTarget
    });
    await emitProgress(params.onProgress, {
      stage: 'sponsor_confirmed',
      message: 'Sponsor gas arrived in trade wallet.'
    });
  } else {
    await emitProgress(params.onProgress, {
      stage: 'sponsor_skipped',
      message: 'Trade wallet already has enough TON for swap gas. No sponsor transfer sent.'
    });
  }

  // 2) Swap requested USDT into TON from the user trade wallet.
  await emitProgress(params.onProgress, {
    stage: 'swap_prepare',
    message: 'Preparing USDT -> TON swap transaction.'
  });

  const { Router, pTON } = dexFactory(simulation.router);
  const router = signer.stonClient.open(new Router(simulation.router.address));
  const proxyTon = pTON.create(simulation.router.ptonMasterAddress);
  const swapTxParams = await router.getSwapJettonToTonTxParams({
    userWalletAddress: signer.sourceWalletAddress,
    receiverAddress: signer.sourceWalletAddress,
    proxyTon,
    offerJettonAddress: simulation.offerAddress,
    offerAmount: simulation.offerUnits,
    minAskAmount: simulation.minAskUnits
  });

  const openedWallet = signer.client.open(signer.wallet);
  const swapSeqno = await openedWallet.getSeqno();
  const swapPreviousHash = await getLatestWalletTxHash(signer.client, signer.wallet.address);
  await openedWallet.sendTransfer({
    seqno: swapSeqno,
    secretKey: signer.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [internal(swapTxParams)]
  });
  const swapTxHash = await waitForNewWalletTxHash({
    client: signer.client,
    wallet: signer.wallet,
    previousHash: swapPreviousHash,
    previousSeqno: swapSeqno
  });
  await emitProgress(params.onProgress, {
    stage: 'swap_submitted',
    message: 'Swap transaction submitted.',
    tx_hash: swapTxHash
  });

  const payoutRequiredTonNano = agentRecoveryTon + 1_000_000n;

  const currentTonAfterSwap = await waitForSwapSettlement({
    signer,
    sourceUsdtWallet,
    sourceWalletAddress: signer.sourceWalletAddress,
    baselineUsdtUnits,
    baselineTonBeforeSponsor,
    swapSeqno,
    payoutRequiredTonNano
  });
  await emitProgress(params.onProgress, {
    stage: 'swap_confirmed',
    message: 'Swap settled. Preparing payout transfer.'
  });

  // 3) Send sponsor recovery + fixed platform fee to agent, then sweep all remaining TON to user.
  const netNewTonNano = currentTonAfterSwap - baselineTonBeforeSponsor;
  if (netNewTonNano <= agentRecoveryTon) {
    throw new Error('Swap completed but payout TON is too low after sponsor recovery/fees.');
  }

  if (agentRecoveryTon > 0n) {
    const feeSeqno = await openedWallet.getSeqno();
    const feePrevHash = await getLatestWalletTxHash(signer.client, signer.wallet.address);
    await openedWallet.sendTransfer({
      seqno: feeSeqno,
      secretKey: signer.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: Address.parse(cfg.AGENT_WALLET_ADDRESS),
          value: agentRecoveryTon,
          bounce: false
        })
      ]
    });
    const feeTxHash = await waitForNewWalletTxHash({
      client: signer.client,
      wallet: signer.wallet,
      previousHash: feePrevHash,
      previousSeqno: feeSeqno
    });
    await emitProgress(params.onProgress, {
      stage: 'agent_fee_sent',
      message: 'Agent sponsor recovery + fee transfer submitted.',
      tx_hash: feeTxHash
    });
  }

  const payoutSeqno = await openedWallet.getSeqno();
  const payoutPrevHash = await getLatestWalletTxHash(signer.client, signer.wallet.address);
  await openedWallet.sendTransfer({
    seqno: payoutSeqno,
    secretKey: signer.secretKey,
    // Carry all remaining balance to destination to avoid TON leftovers in trade wallet.
    sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: Address.parse(destinationWallet),
        value: 1n,
        bounce: false
      })
    ]
  });

  const txHash = await waitForNewWalletTxHash({
    client: signer.client,
    wallet: signer.wallet,
    previousHash: payoutPrevHash,
    previousSeqno: payoutSeqno
  });

  await emitProgress(params.onProgress, {
    stage: 'payout_submitted',
    message: 'Final payout transfer sent to destination wallet.',
    tx_hash: txHash,
    details: {
      destination_wallet: destinationWallet
    }
  });

  return {
    tx_hash: txHash,
    source_wallet: signer.sourceWallet,
    sponsor_tx_hash: sponsorTxHash,
    swap_tx_hash: swapTxHash
  };
}

export const withdrawPricing = {
  sponsor_gas_usdt: GAS_SPONSOR_USDT_EQUIVALENT,
  platform_fee_usdt: PLATFORM_FEE_USDT_EQUIVALENT
} as const;

export async function withdrawUsdtFromUserTradeWallet(params: {
  userId: string;
  amountUsdt: number;
  destinationWallet: string;
  onProgress?: WithdrawalProgressCallback;
}): Promise<{
  tx_hash: string;
  source_wallet: string;
  sponsor_tx_hash: string | null;
  swap_tx_hash: string;
}> {
  const previous = queuedByUser.get(params.userId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withdrawUsdtFromUserTradeWalletInner(params));
  const queuePromise = run.then(() => undefined).catch(() => undefined);
  queuedByUser.set(params.userId, queuePromise);
  run
    .finally(() => {
      if (queuedByUser.get(params.userId) === queuePromise) {
        queuedByUser.delete(params.userId);
      }
    })
    .catch(() => undefined);

  return run;
}
