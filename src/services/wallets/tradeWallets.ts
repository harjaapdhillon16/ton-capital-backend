import crypto from 'node:crypto';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { Address, WalletContractV4 } from '@ton/ton';
import { getConfig } from '../../config.js';
import {
  getUserTradeWalletByUserId,
  setUserTradeWalletAddress,
  upsertUserTradeWallet
} from '../../db/repository.js';

type EncryptedMnemonic = {
  encrypted_mnemonic: string;
  encryption_iv: string;
  encryption_tag: string;
};

const ensureInFlight = new Map<string, Promise<string>>();

function normalizeMnemonic(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function deriveEncryptionKey(): Buffer {
  const config = getConfig();
  const seed = `${normalizeMnemonic(config.AGENT_WALLET_MNEMONIC)}|${Address.parse(
    config.AGENT_WALLET_ADDRESS
  ).toRawString()}`;
  return crypto.createHash('sha256').update(seed).digest();
}

function encryptMnemonic(mnemonic: string): EncryptedMnemonic {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted_mnemonic: encrypted.toString('base64'),
    encryption_iv: iv.toString('base64'),
    encryption_tag: tag.toString('base64')
  };
}

export function decryptMnemonic(encrypted: EncryptedMnemonic): string {
  const key = deriveEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.encryption_iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.encryption_tag, 'base64'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(encrypted.encrypted_mnemonic, 'base64')),
    decipher.final()
  ]);
  return clear.toString('utf8');
}

function normalizeFriendlyAddress(input: string): string {
  return Address.parse(input).toString({
    bounceable: true,
    urlSafe: true
  });
}

async function createUserTradeWallet(): Promise<{
  wallet_address: string;
  public_key: string;
  encrypted_mnemonic: string;
  encryption_iv: string;
  encryption_tag: string;
}> {
  const mnemonicWords = await mnemonicNew(24);
  const mnemonic = mnemonicWords.join(' ');
  const keyPair = await mnemonicToPrivateKey(mnemonicWords);

  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });

  const walletAddress = normalizeFriendlyAddress(wallet.address.toString());
  const encrypted = encryptMnemonic(mnemonic);

  return {
    wallet_address: walletAddress,
    public_key: Buffer.from(keyPair.publicKey).toString('hex'),
    encrypted_mnemonic: encrypted.encrypted_mnemonic,
    encryption_iv: encrypted.encryption_iv,
    encryption_tag: encrypted.encryption_tag
  };
}

async function ensureUserTradeWalletInner(userId: string): Promise<string> {
  const existing = await getUserTradeWalletByUserId(userId);
  if (existing?.wallet_address) {
    const normalized = normalizeFriendlyAddress(existing.wallet_address);
    await setUserTradeWalletAddress(userId, normalized);
    return normalized;
  }

  const created = await createUserTradeWallet();
  await upsertUserTradeWallet({
    user_id: userId,
    wallet_address: created.wallet_address,
    wallet_version: getConfig().USER_TRADE_WALLET_VERSION,
    public_key: created.public_key,
    encrypted_mnemonic: created.encrypted_mnemonic,
    encryption_iv: created.encryption_iv,
    encryption_tag: created.encryption_tag,
    encryption_version: 1
  });
  await setUserTradeWalletAddress(userId, created.wallet_address);
  return created.wallet_address;
}

export async function ensureUserTradeWallet(userId: string): Promise<string> {
  const existing = ensureInFlight.get(userId);
  if (existing) {
    return existing;
  }

  const inFlight = ensureUserTradeWalletInner(userId).finally(() => {
    ensureInFlight.delete(userId);
  });
  ensureInFlight.set(userId, inFlight);
  return inFlight;
}
