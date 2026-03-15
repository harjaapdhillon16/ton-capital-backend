import { mnemonicToPrivateKey } from '@ton/crypto';
import {
  Address,
  beginCell,
  Cell,
  internal,
  JettonMaster,
  SendMode,
  toNano,
  TonClient,
  WalletContractV4
} from '@ton/ton';
import { getConfig } from '../../config.js';

let queued: Promise<void> = Promise.resolve();
let cachedSigner:
  | {
      client: TonClient;
      wallet: WalletContractV4;
      secretKey: Buffer;
      agentAddress: Address;
    }
  | null = null;

function normalizeAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: true, urlSafe: true });
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

  cachedSigner = {
    client: new TonClient({
      endpoint: cfg.TONCENTER_RPC_URL,
      apiKey: cfg.TONCENTER_API_KEY
    }),
    wallet,
    secretKey: Buffer.from(keyPair.secretKey),
    agentAddress: Address.parse(cfg.AGENT_WALLET_ADDRESS)
  };

  return cachedSigner;
}

function buildJettonTransferPayload(params: {
  destination: string;
  responseDestination: string;
  amountUsdt: number;
  queryId: bigint;
}): Cell {
  const amountNano = BigInt(Math.round(params.amountUsdt * 1_000_000));
  return beginCell()
    .storeUint(0xf8a7ea5, 32)
    .storeUint(params.queryId, 64)
    .storeCoins(amountNano)
    .storeAddress(Address.parse(params.destination))
    .storeAddress(Address.parse(params.responseDestination))
    .storeBit(0)
    .storeCoins(1n)
    .storeBit(0)
    .endCell();
}

async function disburseUsdtInner(toWallet: string, amountUsdt: number): Promise<void> {
  const signer = await getSigner();
  const cfg = getConfig();
  const jettonMaster = signer.client.open(JettonMaster.create(Address.parse(cfg.USDT_JETTON_MASTER)));
  const agentJettonWalletAddress = await jettonMaster.getWalletAddress(signer.agentAddress);

  const payload = buildJettonTransferPayload({
    destination: toWallet,
    responseDestination: signer.agentAddress.toString({ bounceable: true, urlSafe: true }),
    amountUsdt,
    queryId: BigInt(Date.now())
  });

  const opened = signer.client.open(signer.wallet);
  const seqno = await opened.getSeqno();

  await opened.sendTransfer({
    seqno,
    secretKey: signer.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: agentJettonWalletAddress,
        value: toNano('0.05'),
        bounce: true,
        body: Cell.fromBoc(payload.toBoc())[0]
      })
    ]
  });
}

export async function disburseUsdtFromTreasury(toWallet: string, amountUsdt: number): Promise<void> {
  const normalizedRecipient = normalizeAddress(toWallet);
  const run = queued.then(() => disburseUsdtInner(normalizedRecipient, amountUsdt));
  queued = run.catch(() => undefined);
  return run;
}
