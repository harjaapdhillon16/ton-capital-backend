import { Address, beginCell } from '@ton/ton';
import { describe, expect, it, vi } from 'vitest';

function applyEnv(): void {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test';
  process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
  process.env.TONCENTER_RPC_URL = process.env.TONCENTER_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC';
  process.env.STORM_API_URL = process.env.STORM_API_URL || 'https://api5.storm.tg/api';
  process.env.ORACLE_URL = process.env.ORACLE_URL || 'https://oracle.storm.tg';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
  process.env.USDT_JETTON_MASTER = process.env.USDT_JETTON_MASTER || 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
  process.env.AGENT_WALLET_ADDRESS =
    process.env.AGENT_WALLET_ADDRESS || 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ';
  process.env.AGENT_WALLET_MNEMONIC =
    process.env.AGENT_WALLET_MNEMONIC ||
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
}

const user = {
  id: 'u1',
  telegram_id: '1',
  wallet_address: null,
  trade_wallet_address: 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ',
  onboarding_completed: true,
  encrypted_mnemonic: 'enc',
  encryption_iv: 'iv',
  encryption_tag: 'tag',
  is_active: true,
  paused: false,
  total_balance_usdt: 100,
  equity_usdt: 100,
  peak_equity_usdt: 100,
  day_start_equity_usdt: 100,
  risk: {
    max_loss_pct: 20,
    allowed_assets: ['crypto'],
    conservative_mode: true
  }
} as const;

describe('StormExecutionService executeDecision', () => {
  it('executes OPEN_LONG by building tx and sending signed transfer', async () => {
    applyEnv();
    const { StormExecutionService } = await import('../src/services/execution/storm.js');

    const service = new StormExecutionService() as any;
    const tx = {
      to: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'),
      value: 100000000n,
      body: beginCell().endCell()
    };

    const createMarketOpenOrder = vi.fn().mockResolvedValue(tx);
    service.getSdkForTrader = vi.fn().mockResolvedValue({ createMarketOpenOrder });
    service.sendTxFromUserWallet = vi.fn().mockResolvedValue('deadbeef');

    const result = await service.executeDecision({
      user,
      decision: {
        asset: 'BTC',
        action: 'OPEN_LONG',
        conviction: 'high',
        conviction_score: 9,
        risk_reward: 2.5,
        thesis: 'x',
        invalidation: 'y',
        position_pct: 5,
        stop_loss_pct: 2,
        take_profit_pct: 4,
        explanation_for_user: 'z'
      },
      amountUsdt: 5,
      leverage: 2,
      idempotencyKey: 'k',
      markPrice: 70000
    });

    expect(createMarketOpenOrder).toHaveBeenCalledTimes(1);
    expect(service.sendTxFromUserWallet).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('executed');
    expect(result.tx_hash).toBe('deadbeef');
    expect(result.order_type).toBe('market_open');
  });

  it('skips CLOSE when no open position is found', async () => {
    applyEnv();
    const { StormExecutionService } = await import('../src/services/execution/storm.js');

    const service = new StormExecutionService() as any;
    service.getSdkForTrader = vi.fn().mockResolvedValue({ createClosePositionOrder: vi.fn() });
    service.resolveClosePositionParams = vi.fn().mockResolvedValue(null);

    const result = await service.executeDecision({
      user,
      decision: {
        asset: 'BTC',
        action: 'CLOSE',
        conviction: 'high',
        conviction_score: 9,
        risk_reward: 2.5,
        thesis: 'x',
        invalidation: 'y',
        position_pct: 0,
        stop_loss_pct: 2,
        take_profit_pct: 4,
        explanation_for_user: 'z'
      },
      amountUsdt: 0,
      leverage: 1,
      idempotencyKey: 'k',
      markPrice: 70000
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('No open position');
  });
});
