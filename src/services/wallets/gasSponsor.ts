import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, internal, SendMode, toNano, TonClient, WalletContractV4 } from '@ton/ton';
import { getConfig } from '../../config.js';

const TX_POLL_INTERVAL_MS = 1500;
const TX_POLL_ATTEMPTS = 80;
let queued: Promise<unknown> = Promise.resolve();
let cachedSigner:
  | {
      client: TonClient;
      wallet: WalletContractV4;
      secretKey: Buffer;
    }
  | null = null;

function normalizeAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: true, urlSafe: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error('Gas sponsor transfer submitted but transaction hash was not indexed in time.');
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
    secretKey: Buffer.from(keyPair.secretKey)
  };

  return cachedSigner;
}

async function sponsorDepositGasInner(recipient: string, amountTon: number): Promise<string> {
  const signer = await getSigner();
  const opened = signer.client.open(signer.wallet);
  const seqno = await opened.getSeqno();
  const previousHash = await getLatestWalletTxHash(signer.client, signer.wallet.address);

  await opened.sendTransfer({
    seqno,
    secretKey: signer.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: Address.parse(recipient),
        value: toNano(amountTon.toFixed(6)),
        bounce: false
      })
    ]
  });

  return waitForNewWalletTxHash({
    client: signer.client,
    wallet: signer.wallet,
    previousHash,
    previousSeqno: seqno
  });
}

export async function sponsorDepositGas(recipient: string, amountTon: number): Promise<string | null> {
  if (amountTon <= 0) {
    return null;
  }

  const normalizedRecipient = normalizeAddress(recipient);
  const run = queued.then(() => sponsorDepositGasInner(normalizedRecipient, amountTon));
  queued = run.catch(() => undefined);
  return run;
}
