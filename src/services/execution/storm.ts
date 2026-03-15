import { StormClient, OracleClient } from '@storm-trade/trading-sdk/api-clients';
import { Direction } from '@storm-trade/trading-sdk/base-packers';
import type { TXParams } from '@storm-trade/trading-sdk/common-packers';
import { StormTradingSdk } from '@storm-trade/trading-sdk/sdk';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, internal, SendMode, TonClient, WalletContractV4 } from '@ton/ton';
import { getConfig } from '../../config.js';
import type { AiDecision } from '../../types/ai.js';
import type { ActiveUser, TradeExecutionResult } from '../../types/domain.js';
import { decryptMnemonic } from '../wallets/tradeWallets.js';

const TX_POLL_INTERVAL_MS = 1500;
const TX_POLL_ATTEMPTS = 100;

type TraderSigner = {
  traderAddress: string;
  wallet: WalletContractV4;
  secretKey: Buffer;
};

export type StormOpenPositionSnapshot = {
  key: string;
  asset: string;
  direction: 'long' | 'short';
  size_base: number;
  size_base_9: string;
  size_usdt: number;
  margin_usdt: number;
  leverage: number;
  entry_price: number;
  mark_price: number;
  pnl_usdt: number;
  storm_position_id: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUsdtUnits(amountUsdt: number): bigint {
  return BigInt(Math.max(0, Math.round(amountUsdt * 1_000_000)));
}

function toPriceUnits(price: number): bigint {
  return BigInt(Math.max(0, Math.round(price * 1_000_000_000)));
}

function normalizeAddress(input: string): string {
  return Address.parse(input).toString({ bounceable: true, urlSafe: true });
}

function fromNineDecimals(value: bigint): number {
  return Number(value) / 1_000_000_000;
}

function isPositiveBigint(value: bigint | undefined | null): value is bigint {
  return typeof value === 'bigint' && value > 0n;
}

export class StormExecutionService {
  private readonly stormClient: StormClient;
  private readonly tonClient: TonClient;
  private readonly sdkByTrader = new Map<string, StormTradingSdk>();
  private readonly sdkInitByTrader = new Map<string, Promise<StormTradingSdk>>();
  private readonly signerByTrader = new Map<string, TraderSigner>();

  constructor() {
    this.stormClient = new StormClient(
      getConfig().STORM_API_URL,
      new OracleClient(getConfig().ORACLE_URL, 2)
    );
    this.tonClient = new TonClient({
      endpoint: getConfig().TONCENTER_RPC_URL,
      apiKey: getConfig().TONCENTER_API_KEY
    });
  }

  private async getSdkForTrader(traderAddress: string): Promise<StormTradingSdk> {
    const normalized = normalizeAddress(traderAddress);
    const existing = this.sdkByTrader.get(normalized);
    if (existing) {
      return existing;
    }

    const inFlight = this.sdkInitByTrader.get(normalized);
    if (inFlight) {
      return inFlight;
    }

    const initPromise = (async () => {
      const sdk = new StormTradingSdk(this.stormClient, this.tonClient, normalized);
      await sdk.init();
      this.sdkByTrader.set(normalized, sdk);
      this.sdkInitByTrader.delete(normalized);
      return sdk;
    })();

    this.sdkInitByTrader.set(normalized, initPromise);
    return initPromise;
  }

  private async getSignerForUser(user: ActiveUser): Promise<TraderSigner> {
    if (!user.trade_wallet_address) {
      throw new Error('User trade wallet is missing.');
    }

    const normalizedAddress = normalizeAddress(user.trade_wallet_address);
    const cached = this.signerByTrader.get(normalizedAddress);
    if (cached) {
      return cached;
    }

    if (!user.encrypted_mnemonic || !user.encryption_iv || !user.encryption_tag) {
      throw new Error('Encrypted trade wallet mnemonic is missing.');
    }

    const mnemonic = decryptMnemonic({
      encrypted_mnemonic: user.encrypted_mnemonic,
      encryption_iv: user.encryption_iv,
      encryption_tag: user.encryption_tag
    });

    const words = mnemonic
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const keyPair = await mnemonicToPrivateKey(words);

    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey
    });

    const derived = normalizeAddress(wallet.address.toString());
    if (derived !== normalizedAddress) {
      throw new Error('Trade wallet mnemonic does not match stored trade wallet address.');
    }

    const signer: TraderSigner = {
      traderAddress: normalizedAddress,
      wallet,
      secretKey: Buffer.from(keyPair.secretKey)
    };

    this.signerByTrader.set(normalizedAddress, signer);
    return signer;
  }

  private async getLatestWalletTxHash(walletAddress: Address): Promise<string | null> {
    const txs = await this.tonClient.getTransactions(walletAddress, { limit: 1, archival: true });
    if (!txs[0]) {
      return null;
    }
    return txs[0].hash().toString('hex');
  }

  private async waitForWalletTxHash(params: {
    wallet: WalletContractV4;
    previousHash: string | null;
    previousSeqno: number;
  }): Promise<string> {
    const openedWallet = this.tonClient.open(params.wallet);

    for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt += 1) {
      await sleep(TX_POLL_INTERVAL_MS);
      const [latestHash, currentSeqno] = await Promise.all([
        this.getLatestWalletTxHash(params.wallet.address),
        openedWallet.getSeqno()
      ]);

      if (latestHash && latestHash !== params.previousHash && currentSeqno > params.previousSeqno) {
        return latestHash;
      }
    }

    throw new Error('Transaction sent but hash was not indexed in time.');
  }

  private async sendTxFromUserWallet(user: ActiveUser, tx: TXParams): Promise<string> {
    const signer = await this.getSignerForUser(user);
    const openedWallet = this.tonClient.open(signer.wallet);
    const [seqno, previousHash] = await Promise.all([
      openedWallet.getSeqno(),
      this.getLatestWalletTxHash(signer.wallet.address)
    ]);

    await openedWallet.sendTransfer({
      seqno,
      secretKey: signer.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: tx.to,
          value: tx.value,
          body: tx.body,
          bounce: true
        })
      ]
    });

    return this.waitForWalletTxHash({
      wallet: signer.wallet,
      previousHash,
      previousSeqno: seqno
    });
  }

  private getActionDirection(action: 'OPEN_LONG' | 'OPEN_SHORT'): Direction {
    return action === 'OPEN_LONG' ? Direction.long : Direction.short;
  }

  private resolveTriggerPrices(params: {
    markPrice: number;
    action: 'OPEN_LONG' | 'OPEN_SHORT';
    stopLossPct: number;
    takeProfitPct?: number;
  }): {
    stopTriggerPrice: bigint;
    takeTriggerPrice?: bigint;
    stopTriggerPriceNum: number;
    takeTriggerPriceNum?: number;
  } {
    const stopMultiplier = params.action === 'OPEN_LONG' ? 1 - params.stopLossPct / 100 : 1 + params.stopLossPct / 100;
    const takePct = params.takeProfitPct && params.takeProfitPct > 0 ? params.takeProfitPct : params.stopLossPct * 2;
    const takeMultiplier = params.action === 'OPEN_LONG' ? 1 + takePct / 100 : 1 - takePct / 100;

    const stop = Math.max(0.0000001, params.markPrice * stopMultiplier);
    const take = Math.max(0.0000001, params.markPrice * takeMultiplier);

    return {
      stopTriggerPrice: toPriceUnits(stop),
      takeTriggerPrice: toPriceUnits(take),
      stopTriggerPriceNum: Number(stop.toFixed(6)),
      takeTriggerPriceNum: Number(take.toFixed(6))
    };
  }

  private async resolveClosePositionParams(
    sdk: StormTradingSdk,
    asset: string
  ): Promise<{ direction: Direction; size: bigint; meta: Record<string, unknown> } | null> {
    try {
      const positionManagerAddress = await sdk.getPositionManagerAddressByAssets({
        baseAssetName: asset,
        collateralAssetName: 'USDT'
      });

      const managerData = await sdk.getPositionManagerData(positionManagerAddress);
      const longSize = managerData?.longPosition?.positionData?.size ?? 0n;
      const shortSize = managerData?.shortPosition?.positionData?.size ?? 0n;

      if (!isPositiveBigint(longSize) && !isPositiveBigint(shortSize)) {
        return null;
      }

      if (isPositiveBigint(longSize) && (!isPositiveBigint(shortSize) || longSize >= shortSize)) {
        return {
          direction: Direction.long,
          size: longSize,
          meta: {
            source_position_manager: positionManagerAddress.toString({ bounceable: true, urlSafe: true }),
            long_size_9: longSize.toString(),
            short_size_9: shortSize.toString()
          }
        };
      }

      return {
        direction: Direction.short,
        size: shortSize,
        meta: {
          source_position_manager: positionManagerAddress.toString({ bounceable: true, urlSafe: true }),
          long_size_9: longSize.toString(),
          short_size_9: shortSize.toString()
        }
      };
    } catch {
      return null;
    }
  }

  async executeDecision(params: {
    user: ActiveUser;
    decision: AiDecision;
    amountUsdt: number;
    leverage: number;
    idempotencyKey: string;
    markPrice: number;
  }): Promise<TradeExecutionResult> {
    const { user, decision, amountUsdt, leverage, markPrice } = params;

    if (decision.action === 'HOLD') {
      return {
        status: 'skipped',
        reason: 'HOLD action'
      };
    }

    if (!user.trade_wallet_address) {
      return {
        status: 'failed',
        reason: 'User trade wallet is missing.'
      };
    }

    try {
      const sdk = await this.getSdkForTrader(user.trade_wallet_address);

      if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
        if (!Number.isFinite(markPrice) || markPrice <= 0) {
          return {
            status: 'failed',
            reason: `Missing mark price for ${decision.asset}.`
          };
        }

        const direction = this.getActionDirection(decision.action);
        const leverageScaled = BigInt(Math.round(leverage * 1_000_000_000));
        const triggers = this.resolveTriggerPrices({
          markPrice,
          action: decision.action,
          stopLossPct: decision.stop_loss_pct,
          takeProfitPct: decision.take_profit_pct
        });

        const txParams = await sdk.createMarketOpenOrder({
          baseAssetName: decision.asset,
          direction,
          amount: toUsdtUnits(amountUsdt),
          leverage: leverageScaled,
          collateralAssetName: 'USDT',
          stopTriggerPrice: triggers.stopTriggerPrice,
          takeTriggerPrice: triggers.takeTriggerPrice
        });

        const txHash = await this.sendTxFromUserWallet(user, txParams);

        return {
          status: 'executed',
          tx_hash: txHash,
          order_type: 'market_open',
          stop_trigger_price: triggers.stopTriggerPriceNum,
          take_trigger_price: triggers.takeTriggerPriceNum,
          execution_meta: {
            amount_usdt: Number(amountUsdt.toFixed(6)),
            leverage,
            idempotency_key: params.idempotencyKey,
            storm_tx_to: txParams.to.toString({ bounceable: true, urlSafe: true }),
            storm_tx_value: txParams.value.toString(),
            mark_price: markPrice
          }
        };
      }

      if (decision.action === 'CLOSE') {
        const close = await this.resolveClosePositionParams(sdk, decision.asset);
        if (!close) {
          return {
            status: 'skipped',
            reason: 'No open position found to close.'
          };
        }

        const txParams = await sdk.createClosePositionOrder({
          baseAssetName: decision.asset,
          collateralAssetName: 'USDT',
          direction: close.direction,
          size: close.size
        });

        const txHash = await this.sendTxFromUserWallet(user, txParams);

        return {
          status: 'executed',
          tx_hash: txHash,
          order_type: 'market_close',
          execution_meta: {
            ...close.meta,
            idempotency_key: params.idempotencyKey,
            close_size_9: close.size.toString(),
            direction: close.direction === Direction.long ? 'long' : 'short',
            storm_tx_to: txParams.to.toString({ bounceable: true, urlSafe: true }),
            storm_tx_value: txParams.value.toString()
          }
        };
      }

      return {
        status: 'skipped',
        reason: 'Unsupported action'
      };
    } catch (error) {
      return {
        status: 'failed',
        reason: (error as Error).message
      };
    }
  }

  async getOpenPositionsForUser(params: {
    user: ActiveUser;
    assets: string[];
    markPrices: Partial<Record<string, number>>;
  }): Promise<StormOpenPositionSnapshot[]> {
    if (!params.user.trade_wallet_address) {
      return [];
    }

    const sdk = await this.getSdkForTrader(params.user.trade_wallet_address);
    const output: StormOpenPositionSnapshot[] = [];

    for (const asset of params.assets) {
      try {
        const positionManagerAddress = await sdk.getPositionManagerAddressByAssets({
          baseAssetName: asset,
          collateralAssetName: 'USDT'
        });

        const managerData = await sdk.getPositionManagerData(positionManagerAddress);
        const markPrice = Number(params.markPrices[asset] ?? 0);

        const appendSnapshot = (record: any, direction: 'long' | 'short'): void => {
          const positionData = record?.positionData;
          const size = positionData?.size as bigint | undefined;
          if (!isPositiveBigint(size)) {
            return;
          }

          const openNotional = fromNineDecimals(positionData.openNotional as bigint);
          const margin = fromNineDecimals(positionData.margin as bigint);
          const sizeBase = fromNineDecimals(size);
          const entryPrice = sizeBase > 0 ? openNotional / sizeBase : 0;
          const mark = markPrice > 0 ? markPrice : entryPrice;
          const pnlRaw = direction === 'long' ? (mark - entryPrice) * sizeBase : (entryPrice - mark) * sizeBase;

          output.push({
            key: `${asset}:${direction}`,
            asset,
            direction,
            size_base: Number(sizeBase.toFixed(9)),
            size_base_9: size.toString(),
            size_usdt: Number(openNotional.toFixed(6)),
            margin_usdt: Number(margin.toFixed(6)),
            leverage: margin > 0 ? Number((openNotional / margin).toFixed(6)) : 1,
            entry_price: Number(entryPrice.toFixed(6)),
            mark_price: Number(mark.toFixed(6)),
            pnl_usdt: Number(pnlRaw.toFixed(6)),
            storm_position_id: positionManagerAddress.toString({ bounceable: true, urlSafe: true })
          });
        };

        appendSnapshot(managerData?.longPosition, 'long');
        appendSnapshot(managerData?.shortPosition, 'short');
      } catch {
        continue;
      }
    }

    return output;
  }
}
