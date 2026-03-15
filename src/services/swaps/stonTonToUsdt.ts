import { StonApiClient } from '@ston-fi/api';
import { Client, dexFactory } from '@ston-fi/sdk';
import { mnemonicToPrivateKey } from '@ton/crypto';
import {
  Address,
  internal,
  JettonMaster,
  JettonWallet,
  SendMode,
  TonClient,
  WalletContractV4
} from '@ton/ton';
import { getConfig } from '../../config.js';

const TON_ASSET_ADDRESS = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const DEFAULT_SLIPPAGE_TOLERANCE = '0.01';
const BALANCE_POLL_ATTEMPTS = 24;
const BALANCE_POLL_INTERVAL_MS = 2500;
const USDT_DECIMALS = 6;

let queued: Promise<void> = Promise.resolve();
let cachedSigner:
  | {
      client: TonClient;
      stonClient: Client;
      wallet: WalletContractV4;
      secretKey: Buffer;
      agentAddress: Address;
      usdtWalletAddress: Address;
    }
  | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: true, urlSafe: true });
}

function toNanoUnits(tonAmount: number): bigint {
  const [wholePart, fractionPart = ''] = tonAmount.toFixed(9).split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart + '000000000').slice(0, 9));
  return whole * 1_000_000_000n + fraction;
}

function toUsdtUnits(usdtAmount: number): bigint {
  const [wholePart, fractionPart = ''] = usdtAmount.toFixed(USDT_DECIMALS).split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart + '000000').slice(0, USDT_DECIMALS));
  return whole * 1_000_000n + fraction;
}

export async function estimateTonForUsdtSwap(
  targetUsdtAmount: number
): Promise<{ offerTonNano: bigint; minAskUsdtUnits: bigint; priceImpactPct: number | null }> {
  if (!Number.isFinite(targetUsdtAmount) || targetUsdtAmount <= 0) {
    throw new Error('Invalid target USDT amount for reverse swap quote.');
  }

  const api = new StonApiClient();
  const simulation = await api.simulateReverseSwap({
    offerAddress: TON_ASSET_ADDRESS,
    askAddress: getConfig().USDT_JETTON_MASTER,
    askUnits: toUsdtUnits(targetUsdtAmount).toString(),
    slippageTolerance: DEFAULT_SLIPPAGE_TOLERANCE
  });

  const offerTonNano = BigInt(simulation.offerUnits);
  if (offerTonNano <= 0n) {
    throw new Error('Reverse swap quote returned zero TON offer amount.');
  }

  const minAskUsdtUnits = BigInt(simulation.minAskUnits);
  const priceImpact = Number(simulation.priceImpact);
  return {
    offerTonNano,
    minAskUsdtUnits,
    priceImpactPct: Number.isFinite(priceImpact) ? priceImpact : null
  };
}

async function getSigner() {
  if (cachedSigner) {
    return cachedSigner;
  }

  const cfg = getConfig();
  const words = cfg.AGENT_WALLET_MNEMONIC.trim().split(/\s+/).filter(Boolean);
  const keyPair = await mnemonicToPrivateKey(words);

  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });

  const derived = normalizeAddress(wallet.address.toString());
  const configured = normalizeAddress(cfg.AGENT_WALLET_ADDRESS);
  if (derived !== configured) {
    throw new Error('AGENT_WALLET_MNEMONIC does not match AGENT_WALLET_ADDRESS.');
  }

  const tonClient = new TonClient({
    endpoint: cfg.TONCENTER_RPC_URL,
    apiKey: cfg.TONCENTER_API_KEY
  });
  const stonClient = new Client({
    endpoint: cfg.TONCENTER_RPC_URL,
    apiKey: cfg.TONCENTER_API_KEY
  });

  const agentAddress = Address.parse(cfg.AGENT_WALLET_ADDRESS);
  const usdtMaster = tonClient.open(JettonMaster.create(Address.parse(cfg.USDT_JETTON_MASTER)));
  const usdtWalletAddress = await usdtMaster.getWalletAddress(agentAddress);

  cachedSigner = {
    client: tonClient,
    stonClient,
    wallet,
    secretKey: Buffer.from(keyPair.secretKey),
    agentAddress,
    usdtWalletAddress
  };

  return cachedSigner;
}

async function getUsdtBalance(signer: Awaited<ReturnType<typeof getSigner>>): Promise<bigint> {
  const usdtWallet = signer.client.open(JettonWallet.create(signer.usdtWalletAddress));
  return usdtWallet.getBalance();
}

async function executeTonToUsdtSwapInner(offerTonAmount: number): Promise<{ receivedUsdtUnits: bigint }> {
  if (!Number.isFinite(offerTonAmount) || offerTonAmount <= 0) {
    throw new Error('Invalid TON swap amount.');
  }

  const signer = await getSigner();
  const api = new StonApiClient();
  const beforeBalance = await getUsdtBalance(signer);

  const offerUnits = toNanoUnits(offerTonAmount).toString();
  const simulation = await api.simulateSwap({
    offerAddress: TON_ASSET_ADDRESS,
    offerUnits,
    askAddress: getConfig().USDT_JETTON_MASTER,
    slippageTolerance: DEFAULT_SLIPPAGE_TOLERANCE
  });

  const { Router, pTON } = dexFactory(simulation.router);
  const router = signer.stonClient.open(new Router(simulation.router.address));
  const proxyTon = pTON.create(simulation.router.ptonMasterAddress);

  const txParams = await router.getSwapTonToJettonTxParams({
    userWalletAddress: signer.agentAddress,
    proxyTon,
    askJettonAddress: simulation.askAddress,
    offerAmount: simulation.offerUnits,
    minAskAmount: simulation.minAskUnits
  });

  const openedWallet = signer.client.open(signer.wallet);
  const seqno = await openedWallet.getSeqno();
  await openedWallet.sendTransfer({
    seqno,
    secretKey: signer.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [internal(txParams)]
  });

  for (let attempt = 0; attempt < BALANCE_POLL_ATTEMPTS; attempt += 1) {
    await sleep(BALANCE_POLL_INTERVAL_MS);
    const currentBalance = await getUsdtBalance(signer);
    const delta = currentBalance - beforeBalance;
    if (delta > 0n) {
      return { receivedUsdtUnits: delta };
    }
  }

  throw new Error('Swap transaction submitted but USDT was not received in time.');
}

export async function executeTonToUsdtSwap(offerTonAmount: number): Promise<{ receivedUsdtUnits: bigint }> {
  const run = queued.then(() => executeTonToUsdtSwapInner(offerTonAmount));
  queued = run.then(() => undefined).catch(() => undefined);
  return run;
}
