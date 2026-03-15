import { Address, JettonMaster, JettonWallet, TonClient } from '@ton/ton';
import { getConfig } from '../../config.js';
import { getAppProfileByUserId } from '../../db/repository.js';
import { ensureUserTradeWallet } from './tradeWallets.js';

export type TradeWalletBalances = {
  trade_wallet_address: string;
  ton_balance: number;
  ton_balance_nano: string;
  usdt_balance: number;
  usdt_balance_units: string;
};

const tonClient = new TonClient({
  endpoint: getConfig().TONCENTER_RPC_URL,
  apiKey: getConfig().TONCENTER_API_KEY
});

async function resolveTradeWalletAddress(
  userId: string,
  preferredAddress?: string | null
): Promise<string> {
  if (preferredAddress) {
    return Address.parse(preferredAddress).toString({ bounceable: true, urlSafe: true });
  }

  const profile = await getAppProfileByUserId(userId);
  if (profile.trade_wallet_address) {
    return Address.parse(profile.trade_wallet_address).toString({ bounceable: true, urlSafe: true });
  }

  return ensureUserTradeWallet(userId);
}

export async function getTradeWalletBalancesForUser(params: {
  userId: string;
  tradeWalletAddress?: string | null;
}): Promise<TradeWalletBalances> {
  const resolvedAddress = await resolveTradeWalletAddress(params.userId, params.tradeWalletAddress);
  const tradeAddress = Address.parse(resolvedAddress);
  const tonBalanceNano = await tonClient.getBalance(tradeAddress);

  const usdtMaster = tonClient.open(JettonMaster.create(Address.parse(getConfig().USDT_JETTON_MASTER)));
  const usdtWalletAddress = await usdtMaster.getWalletAddress(tradeAddress);

  let usdtBalanceUnits = 0n;
  try {
    const usdtWallet = tonClient.open(JettonWallet.create(usdtWalletAddress));
    usdtBalanceUnits = await usdtWallet.getBalance();
  } catch {
    // Jetton wallet may be undeployed for fresh wallets.
    usdtBalanceUnits = 0n;
  }

  return {
    trade_wallet_address: tradeAddress.toString({ bounceable: true, urlSafe: true }),
    ton_balance: Number(tonBalanceNano) / 1_000_000_000,
    ton_balance_nano: tonBalanceNano.toString(),
    usdt_balance: Number(usdtBalanceUnits) / 1_000_000,
    usdt_balance_units: usdtBalanceUnits.toString()
  };
}
