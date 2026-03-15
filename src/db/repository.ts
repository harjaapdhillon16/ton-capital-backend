import type { AiDecision, MarketBriefing } from '../types/ai.js';
import type { ActiveUser, AssetClass } from '../types/domain.js';
import { supabase } from './client.js';

type TelegramIdentity = {
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
};

export type WithdrawalProgressEvent = {
  stage: string;
  message: string;
  at: string;
  tx_hash: string | null;
  details?: Record<string, unknown>;
};

function normalizeTelegramId(value: string): string {
  return value.trim();
}

export async function acquireAgentLock(lockName: string, owner: string, ttlSeconds: number): Promise<boolean> {
  const { data, error } = await supabase.rpc('acquire_agent_lock', {
    p_lock_name: lockName,
    p_owner_id: owner,
    p_ttl_seconds: ttlSeconds
  });

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export async function releaseAgentLock(lockName: string, owner: string): Promise<void> {
  const { error } = await supabase.rpc('release_agent_lock', {
    p_lock_name: lockName,
    p_owner_id: owner
  });

  if (error) {
    throw error;
  }
}

export async function getSystemControls(): Promise<{
  trading_enabled: boolean;
  max_global_exposure_usdt: number;
  launch_cap_enabled: boolean;
}> {
  const { data, error } = await supabase
    .from('system_controls')
    .select('trading_enabled,max_global_exposure_usdt,launch_cap_enabled')
    .eq('id', 1)
    .single();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error('Withdrawal insertion returned no row.');
  }

  return {
    trading_enabled: Boolean(data.trading_enabled),
    max_global_exposure_usdt: Number(data.max_global_exposure_usdt ?? 0),
    launch_cap_enabled: Boolean(data.launch_cap_enabled)
  };
}

export async function createAgentRun(runId: string): Promise<void> {
  const { error } = await supabase.from('agent_runs').insert({
    id: runId,
    status: 'running',
    started_at: new Date().toISOString()
  });

  if (error) {
    throw error;
  }
}

export async function completeAgentRun(
  runId: string,
  status: 'completed' | 'failed' | 'skipped',
  errorMessage?: string
): Promise<void> {
  const { error } = await supabase
    .from('agent_runs')
    .update({
      status,
      error_message: errorMessage ?? null,
      finished_at: new Date().toISOString()
    })
    .eq('id', runId);

  if (error) {
    throw error;
  }
}

export async function insertBriefing(runId: string, briefing: MarketBriefing, decisions: AiDecision[]): Promise<void> {
  const { error } = await supabase.from('briefings').insert({
    run_id: runId,
    raw_data: briefing,
    decisions,
    created_at: new Date().toISOString()
  });

  if (error) {
    throw error;
  }
}

export async function upsertUser(identity: TelegramIdentity): Promise<string> {
  const telegramId = normalizeTelegramId(identity.telegram_id);
  const displayName =
    [identity.first_name, identity.last_name].filter(Boolean).join(' ').trim() ||
    identity.username ||
    null;

  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: telegramId,
        username: identity.username,
        first_name: identity.first_name,
        last_name: identity.last_name,
        display_name: displayName,
        telegram_auth_at: new Date().toISOString(),
        is_active: true,
        paused: false,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'telegram_id' }
    )
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  const userId = data.id as string;

  const { error: riskError } = await supabase.from('risk_profiles').upsert(
    {
      user_id: userId,
      max_loss_pct: 20,
      allowed_assets: ['crypto', 'gold'],
      conservative_mode: true
    },
    { onConflict: 'user_id', ignoreDuplicates: true }
  );

  if (riskError) {
    throw riskError;
  }

  return userId;
}

export async function bindWallet(userId: string, walletAddress: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ wallet_address: walletAddress, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    throw error;
  }
}

export async function getUserById(userId: string): Promise<{
  id: string;
  telegram_id: string;
  wallet_address: string | null;
  trade_wallet_address: string | null;
} | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id,telegram_id,wallet_address,trade_wallet_address')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    telegram_id: data.telegram_id as string,
    wallet_address: (data.wallet_address as string | null) ?? null,
    trade_wallet_address: (data.trade_wallet_address as string | null) ?? null
  };
}

export async function setUserTradeWalletAddress(userId: string, tradeWalletAddress: string): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ trade_wallet_address: tradeWalletAddress, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    throw error;
  }
}

export async function upsertUserTradeWallet(record: {
  user_id: string;
  wallet_address: string;
  wallet_version: string;
  public_key: string;
  encrypted_mnemonic: string;
  encryption_iv: string;
  encryption_tag: string;
  encryption_version: number;
}): Promise<void> {
  const { error } = await supabase.from('user_trade_wallets').upsert(
    {
      user_id: record.user_id,
      wallet_address: record.wallet_address,
      wallet_version: record.wallet_version,
      public_key: record.public_key,
      encrypted_mnemonic: record.encrypted_mnemonic,
      encryption_iv: record.encryption_iv,
      encryption_tag: record.encryption_tag,
      encryption_version: record.encryption_version,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'user_id' }
  );

  if (error) {
    throw error;
  }
}

export async function getUserTradeWalletByUserId(userId: string): Promise<{
  wallet_address: string;
  wallet_version: string;
  public_key: string;
  encrypted_mnemonic: string;
  encryption_iv: string;
  encryption_tag: string;
  encryption_version: number;
} | null> {
  const { data, error } = await supabase
    .from('user_trade_wallets')
    .select(
      'wallet_address,wallet_version,public_key,encrypted_mnemonic,encryption_iv,encryption_tag,encryption_version'
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    wallet_address: data.wallet_address as string,
    wallet_version: (data.wallet_version as string) ?? 'v4',
    public_key: data.public_key as string,
    encrypted_mnemonic: data.encrypted_mnemonic as string,
    encryption_iv: data.encryption_iv as string,
    encryption_tag: data.encryption_tag as string,
    encryption_version: Number(data.encryption_version ?? 1)
  };
}

export async function completeOnboarding(
  userId: string,
  payload: {
    name: string;
    risk_level: 'conservative' | 'balanced' | 'aggressive';
    max_loss_pct: number;
    allowed_assets: AssetClass[];
    wallet_address: string;
    trade_wallet_address: string | null;
  }
): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({
      display_name: payload.name,
      wallet_address: payload.wallet_address,
      trade_wallet_address: payload.trade_wallet_address,
      onboarding_completed: true,
      onboarding_completed_at: new Date().toISOString(),
      onboarding_risk_level: payload.risk_level,
      onboarding_assets: payload.allowed_assets,
      onboarding_payload: payload,
      updated_at: new Date().toISOString()
    })
    .eq('id', userId);

  if (error) {
    throw error;
  }
}

export async function getAppProfileByUserId(userId: string): Promise<{
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  wallet_address: string | null;
  trade_wallet_address: string | null;
  onboarding_completed: boolean;
  onboarding_completed_at: string | null;
  onboarding_risk_level: string | null;
  onboarding_assets: AssetClass[];
  max_loss_pct: number;
  allowed_assets: AssetClass[];
}> {
  const { data: userRows, error: userError } = await supabase
    .from('users')
    .select(
      'id,telegram_id,username,first_name,last_name,display_name,wallet_address,trade_wallet_address,onboarding_completed,onboarding_completed_at,onboarding_risk_level,onboarding_assets'
    )
    .eq('id', userId)
    .limit(1);

  if (userError) {
    throw userError;
  }

  const user = (userRows ?? [])[0] as
    | {
      id: string;
      telegram_id: string;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      display_name: string | null;
      wallet_address: string | null;
      trade_wallet_address: string | null;
      onboarding_completed: boolean | null;
      onboarding_completed_at: string | null;
      onboarding_risk_level: string | null;
      onboarding_assets: AssetClass[] | null;
    }
    | undefined;

  if (!user) {
    throw new Error('User profile not found.');
  }


  const { data: riskRows, error: riskError } = await supabase
    .from('risk_profiles')
    .select('max_loss_pct,allowed_assets')
    .eq('user_id', userId)
    .limit(1);

  if (riskError) {
    throw riskError;
  }

  const risk = (riskRows ?? [])[0] as
    | {
      max_loss_pct: number | null;
      allowed_assets: AssetClass[] | null;
    }
    | undefined;

  return {
    id: user.id as string,
    telegram_id: user.telegram_id as string,
    username: (user.username as string | null) ?? null,
    first_name: (user.first_name as string | null) ?? null,
    last_name: (user.last_name as string | null) ?? null,
    display_name: (user.display_name as string | null) ?? null,
    wallet_address: (user.wallet_address as string | null) ?? null,
    trade_wallet_address: (user.trade_wallet_address as string | null) ?? null,
    onboarding_completed: Boolean(user.onboarding_completed),
    onboarding_completed_at: (user.onboarding_completed_at as string | null) ?? null,
    onboarding_risk_level: (user.onboarding_risk_level as string | null) ?? null,
    onboarding_assets: ((user.onboarding_assets as AssetClass[] | null) ?? []) as AssetClass[],
    max_loss_pct: Number(risk?.max_loss_pct ?? 20),
    allowed_assets: ((risk?.allowed_assets as AssetClass[] | null) ?? ['crypto']) as AssetClass[]
  };
}

export async function getUserIdByTelegramId(telegramId: string): Promise<string | null> {
  const normalizedTelegramId = normalizeTelegramId(telegramId);
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', normalizedTelegramId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  const row = (data ?? [])[0] as { id: string } | undefined;
  return row?.id ?? null;
}

export async function getPortfolioByUser(userId: string): Promise<Record<string, unknown>> {
  const { data: userRows, error } = await supabase
    .from('users')
    .select('total_balance_usdt, equity_usdt, day_pnl_usdt, drawdown_pct, paused')
    .eq('id', userId)
    .limit(1);

  if (error) {
    throw error;
  }

  const user = (userRows ?? [])[0] as
    | {
      total_balance_usdt: number | null;
      equity_usdt: number | null;
      day_pnl_usdt: number | null;
      drawdown_pct: number | null;
      paused: boolean | null;
    }
    | undefined;

  const { data: riskRows, error: riskError } = await supabase
    .from('risk_profiles')
    .select('max_loss_pct')
    .eq('user_id', userId)
    .limit(1);

  if (riskError) {
    throw riskError;
  }

  const riskData = (riskRows ?? [])[0] as { max_loss_pct: number | null } | undefined;

  return {
    total_balance_usdt: Number(user?.total_balance_usdt ?? 0),
    equity_usdt: Number(user?.equity_usdt ?? 0),
    pnl_day_usdt: Number(user?.day_pnl_usdt ?? 0),
    drawdown_pct: Number(user?.drawdown_pct ?? 0),
    max_loss_pct: Number(riskData?.max_loss_pct ?? 20),
    trading_enabled: !Boolean(user?.paused)
  };
}

export async function getPositionsByUser(userId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('id,asset,direction,size_usdt,leverage,entry_price,mark_price,pnl_usdt,stop_loss_pct,opened_at')
    .eq('user_id', userId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getFeedByUser(userId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from('trades')
    .select('id,created_at,asset,action,thesis,invalidation,explanation')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    throw error;
  }

  return (
    data?.map((item) => ({
      id: item.id,
      created_at: item.created_at,
      asset: item.asset,
      action: item.action,
      thesis: item.thesis,
      invalidation: item.invalidation,
      explanation_for_user: item.explanation
    })) ?? []
  );
}

export type BotConversationRole = 'user' | 'assistant';

export type BotConversationRecord = {
  user_id: string;
  telegram_chat_id: string;
  telegram_message_id?: number | null;
  role: BotConversationRole;
  content: string;
  context_snapshot?: Record<string, unknown> | null;
};

export async function appendBotConversationMessage(record: BotConversationRecord): Promise<void> {
  const { error } = await supabase.from('bot_conversations').insert({
    user_id: record.user_id,
    telegram_chat_id: record.telegram_chat_id,
    telegram_message_id: record.telegram_message_id ?? null,
    role: record.role,
    content: record.content,
    context_snapshot: record.context_snapshot ?? null,
    created_at: new Date().toISOString()
  });

  if (error) {
    throw error;
  }
}

export async function getRecentBotConversationMessages(params: {
  user_id: string;
  telegram_chat_id: string;
  limit?: number;
}): Promise<Array<{ role: BotConversationRole; content: string; created_at: string }>> {
  const limit = Math.min(30, Math.max(1, params.limit ?? 12));
  const { data, error } = await supabase
    .from('bot_conversations')
    .select('role,content,created_at')
    .eq('user_id', params.user_id)
    .eq('telegram_chat_id', params.telegram_chat_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (
    (data ?? [])
      .slice()
      .reverse()
      .filter(
        (item): item is { role: BotConversationRole; content: string; created_at: string } =>
          (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && typeof item.created_at === 'string'
      )
      .map((item) => ({
        role: item.role,
        content: item.content,
        created_at: item.created_at
      }))
  );
}

export async function updateRiskProfile(
  userId: string,
  profile: { max_loss_pct: number; allowed_assets: AssetClass[] }
): Promise<void> {
  const { error } = await supabase.from('risk_profiles').upsert(
    {
      user_id: userId,
      max_loss_pct: profile.max_loss_pct,
      allowed_assets: profile.allowed_assets,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'user_id' }
  );

  if (error) {
    throw error;
  }
}

export async function setUserPause(userId: string, paused: boolean): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ paused, updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) {
    throw error;
  }
}

export async function getActiveUsers(): Promise<ActiveUser[]> {
  const { data, error } = await supabase
    .from('users')
    .select(
      'id,telegram_id,wallet_address,trade_wallet_address,onboarding_completed,is_active,paused,total_balance_usdt,equity_usdt,peak_equity_usdt,day_start_equity_usdt,risk_profiles(max_loss_pct,allowed_assets,conservative_mode),user_trade_wallets(encrypted_mnemonic,encryption_iv,encryption_tag)'
    )
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row: any) => {
    const riskRow = Array.isArray(row.risk_profiles) ? row.risk_profiles[0] : row.risk_profiles;
    const tradeWalletRow = Array.isArray(row.user_trade_wallets)
      ? row.user_trade_wallets[0]
      : row.user_trade_wallets;
    return {
      id: row.id,
      telegram_id: row.telegram_id,
      wallet_address: row.wallet_address,
      trade_wallet_address: row.trade_wallet_address,
      onboarding_completed: Boolean(row.onboarding_completed),
      encrypted_mnemonic: tradeWalletRow?.encrypted_mnemonic ?? null,
      encryption_iv: tradeWalletRow?.encryption_iv ?? null,
      encryption_tag: tradeWalletRow?.encryption_tag ?? null,
      is_active: row.is_active,
      paused: row.paused,
      total_balance_usdt: Number(row.total_balance_usdt ?? 0),
      equity_usdt: Number(row.equity_usdt ?? 0),
      peak_equity_usdt: Number(row.peak_equity_usdt ?? 0),
      day_start_equity_usdt: Number(row.day_start_equity_usdt ?? 0),
      risk: {
        max_loss_pct: Number(riskRow?.max_loss_pct ?? 20),
        allowed_assets: (riskRow?.allowed_assets ?? ['crypto']) as AssetClass[],
        conservative_mode: Boolean(riskRow?.conservative_mode ?? true)
      }
    };
  });
}

export async function updateUserBalanceSnapshot(params: {
  user_id: string;
  equity_usdt: number;
  total_balance_usdt: number;
}): Promise<{
  equity_usdt: number;
  total_balance_usdt: number;
  peak_equity_usdt: number;
  day_start_equity_usdt: number;
  day_pnl_usdt: number;
  drawdown_pct: number;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('users')
    .select('peak_equity_usdt,day_start_equity_usdt,day_start_date')
    .eq('id', params.user_id)
    .single();

  if (error && !/day_start_date/i.test(error.message)) {
    throw error;
  }

  const peakPrev = Number((data as any)?.peak_equity_usdt ?? 0);
  let dayStart = Number((data as any)?.day_start_equity_usdt ?? 0);
  const dayStartDate = ((data as any)?.day_start_date as string | null) ?? null;

  if (!dayStart || dayStart < 0 || dayStartDate !== today) {
    dayStart = params.equity_usdt;
  }

  const peak = Math.max(peakPrev, params.equity_usdt);
  const dayPnl = Number((params.equity_usdt - dayStart).toFixed(6));
  const drawdown = peak > 0 ? Number((((peak - params.equity_usdt) / peak) * 100).toFixed(6)) : 0;

  const patch = {
    total_balance_usdt: Number(params.total_balance_usdt.toFixed(6)),
    equity_usdt: Number(params.equity_usdt.toFixed(6)),
    peak_equity_usdt: Number(peak.toFixed(6)),
    day_start_equity_usdt: Number(dayStart.toFixed(6)),
    day_pnl_usdt: dayPnl,
    drawdown_pct: drawdown,
    day_start_date: today,
    updated_at: new Date().toISOString()
  };

  let update = await supabase.from('users').update(patch).eq('id', params.user_id);
  if (update.error && /day_start_date/i.test(update.error.message)) {
    const fallbackPatch = { ...patch } as Record<string, unknown>;
    delete fallbackPatch.day_start_date;
    update = await supabase.from('users').update(fallbackPatch).eq('id', params.user_id);
  }

  if (update.error) {
    throw update.error;
  }

  return {
    equity_usdt: Number(params.equity_usdt.toFixed(6)),
    total_balance_usdt: Number(params.total_balance_usdt.toFixed(6)),
    peak_equity_usdt: Number(peak.toFixed(6)),
    day_start_equity_usdt: Number(dayStart.toFixed(6)),
    day_pnl_usdt: dayPnl,
    drawdown_pct: drawdown
  };
}

export async function upsertOpenPositionSnapshot(record: {
  user_id: string;
  asset: string;
  direction: string;
  size_usdt: number;
  leverage: number;
  entry_price: number;
  mark_price: number;
  pnl_usdt: number;
  stop_loss_pct: number;
  storm_position_id: string | null;
  base_size_9?: string | null;
  margin_usdt?: number | null;
  open_notional_usdt?: number | null;
}): Promise<void> {
  const { data: existing, error: existingError } = await supabase
    .from('positions')
    .select('id')
    .eq('user_id', record.user_id)
    .eq('asset', record.asset)
    .eq('direction', record.direction)
    .eq('status', 'open')
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  const patch = {
    size_usdt: Number(record.size_usdt.toFixed(6)),
    leverage: Number(record.leverage.toFixed(6)),
    entry_price: Number(record.entry_price.toFixed(6)),
    mark_price: Number(record.mark_price.toFixed(6)),
    pnl_usdt: Number(record.pnl_usdt.toFixed(6)),
    stop_loss_pct: Number(record.stop_loss_pct.toFixed(6)),
    storm_position_id: record.storm_position_id,
    base_size_9: record.base_size_9 ?? null,
    margin_usdt: record.margin_usdt ?? null,
    open_notional_usdt: record.open_notional_usdt ?? null,
    last_synced_at: new Date().toISOString()
  };

  let result;
  if (existing?.id) {
    result = await supabase.from('positions').update(patch).eq('id', existing.id);
  } else {
    result = await supabase.from('positions').insert({
      user_id: record.user_id,
      asset: record.asset,
      direction: record.direction,
      size_usdt: patch.size_usdt,
      leverage: patch.leverage,
      entry_price: patch.entry_price,
      mark_price: patch.mark_price,
      pnl_usdt: patch.pnl_usdt,
      stop_loss_pct: patch.stop_loss_pct,
      storm_position_id: patch.storm_position_id,
      base_size_9: patch.base_size_9,
      margin_usdt: patch.margin_usdt,
      open_notional_usdt: patch.open_notional_usdt,
      status: 'open',
      opened_at: new Date().toISOString(),
      last_synced_at: patch.last_synced_at
    });
  }

  if (
    result.error &&
    /base_size_9|margin_usdt|open_notional_usdt|last_synced_at/i.test(result.error.message)
  ) {
    const fallbackPatch = {
      size_usdt: patch.size_usdt,
      leverage: patch.leverage,
      entry_price: patch.entry_price,
      mark_price: patch.mark_price,
      pnl_usdt: patch.pnl_usdt,
      stop_loss_pct: patch.stop_loss_pct,
      storm_position_id: patch.storm_position_id
    };

    const fallback = existing?.id
      ? await supabase.from('positions').update(fallbackPatch).eq('id', existing.id)
      : await supabase.from('positions').insert({
          user_id: record.user_id,
          asset: record.asset,
          direction: record.direction,
          status: 'open',
          opened_at: new Date().toISOString(),
          ...fallbackPatch
        });

    if (fallback.error) {
      throw fallback.error;
    }
    return;
  }

  if (result.error) {
    throw result.error;
  }
}

export async function closeMissingOpenPositions(userId: string, activePositionKeys: string[]): Promise<void> {
  const { data: rows, error } = await supabase
    .from('positions')
    .select('id,asset,direction')
    .eq('user_id', userId)
    .eq('status', 'open');

  if (error) {
    throw error;
  }

  const activeSet = new Set(activePositionKeys);
  const staleIds = (rows ?? [])
    .filter((row: any) => !activeSet.has(`${row.asset}:${row.direction}`))
    .map((row: any) => row.id as string);

  if (staleIds.length === 0) {
    return;
  }

  const { error: closeError } = await supabase
    .from('positions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString()
    })
    .in('id', staleIds);

  if (closeError) {
    throw closeError;
  }
}

export async function hasTradeByIdempotency(key: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('trades')
    .select('id')
    .eq('idempotency_key', key)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export async function insertTrade(record: {
  user_id: string;
  run_id: string;
  idempotency_key: string;
  asset: string;
  action: string;
  amount_usdt: number;
  position_pct: number;
  stop_loss_pct: number;
  thesis: string;
  invalidation: string;
  explanation: string;
  status: string;
  external_id?: string;
  tx_hash?: string;
  failure_reason?: string;
  conviction_score?: number;
  risk_reward?: number;
  take_profit_pct?: number;
  rejection_category?: string;
  order_type?: string;
  stop_trigger_price?: number;
  take_trigger_price?: number;
  execution_meta?: Record<string, unknown>;
}): Promise<void> {
  const row = {
    ...record,
    created_at: new Date().toISOString()
  };
  let { error } = await supabase.from('trades').insert(row);

  if (
    error &&
    /conviction_score|risk_reward|take_profit_pct|rejection_category|order_type|stop_trigger_price|take_trigger_price|execution_meta/i.test(
      error.message
    )
  ) {
    const fallbackRow = {
      user_id: record.user_id,
      run_id: record.run_id,
      idempotency_key: record.idempotency_key,
      asset: record.asset,
      action: record.action,
      amount_usdt: record.amount_usdt,
      position_pct: record.position_pct,
      stop_loss_pct: record.stop_loss_pct,
      thesis: record.thesis,
      invalidation: record.invalidation,
      explanation: record.explanation,
      status: record.status,
      external_id: record.external_id,
      tx_hash: record.tx_hash,
      failure_reason: record.failure_reason,
      created_at: new Date().toISOString()
    };
    const fallbackInsert = await supabase.from('trades').insert(fallbackRow);
    error = fallbackInsert.error;
  }

  if (error) {
    throw error;
  }
}

export async function insertNotification(record: {
  user_id: string;
  run_id: string;
  channel: 'telegram';
  payload: Record<string, unknown>;
  status: 'sent' | 'failed';
  error_message?: string;
}): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    ...record,
    created_at: new Date().toISOString()
  });

  if (error) {
    throw error;
  }
}

export async function createDepositIntent(record: {
  user_id: string;
  amount_usdt: number;
  wallet_address: string;
  destination_wallet: string;
  jetton_master: string;
  quoted_ton_amount?: number;
  quoted_ton_price_usd?: number;
}): Promise<{ intent_id: string }> {
  const baseRow = {
    user_id: record.user_id,
    amount_usdt: record.amount_usdt,
    wallet_address: record.wallet_address,
    destination_wallet: record.destination_wallet,
    jetton_master: record.jetton_master,
    status: 'intent_created',
    created_at: new Date().toISOString()
  };

  const insertWithQuote = async () =>
    supabase
      .from('deposits')
      .insert({
        ...baseRow,
        quoted_ton_amount: record.quoted_ton_amount,
        quoted_ton_price_usd: record.quoted_ton_price_usd
      })
      .select('id')
      .single();

  let { data, error } = await insertWithQuote();

  if (error && /quoted_ton_(amount|price_usd)/i.test(error.message)) {
    const fallback = await supabase.from('deposits').insert(baseRow).select('id').single();
    data = fallback.data;
    error = fallback.error;
  }

  if (error) throw error;
  if (!data) {
    throw new Error('Deposit intent insertion returned no id.');
  }
  return { intent_id: data.id as string };
}

export async function updateDepositStatus(record: {
  user_id: string;
  intent_id: string;
  status: string;
  tx_hash?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: record.status
  };

  if (record.tx_hash !== undefined) {
    patch.tx_hash = record.tx_hash;
  }

  if (record.status === 'confirmed') {
    patch.confirmed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('deposits')
    .update(patch)
    .eq('id', record.intent_id)
    .eq('user_id', record.user_id);

  if (error) {
    throw error;
  }
}

export async function getDepositStatusByIntent(record: {
  user_id: string;
  intent_id: string;
}): Promise<{
  intent_id: string;
  status: string;
  amount_usdt: number;
  wallet_address: string | null;
  quoted_ton_amount: number | null;
  tx_hash: string | null;
  created_at: string;
  confirmed_at: string | null;
} | null> {
  const { data, error } = await supabase
    .from('deposits')
    .select('id,status,amount_usdt,wallet_address,quoted_ton_amount,tx_hash,created_at,confirmed_at')
    .eq('id', record.intent_id)
    .eq('user_id', record.user_id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    intent_id: data.id as string,
    status: data.status as string,
    amount_usdt: Number(data.amount_usdt ?? 0),
    wallet_address: (data.wallet_address as string | null) ?? null,
    quoted_ton_amount: data.quoted_ton_amount == null ? null : Number(data.quoted_ton_amount),
    tx_hash: (data.tx_hash as string | null) ?? null,
    created_at: data.created_at as string,
    confirmed_at: (data.confirmed_at as string | null) ?? null
  };
}

export async function createWithdrawalRequest(record: {
  user_id: string;
  amount_usdt: number;
  destination_wallet: string;
}): Promise<{
  id: string;
  user_id: string;
  amount_usdt: number;
  destination_wallet: string;
  tx_hash: string | null;
  status: string;
  created_at: string;
  processed_at: string | null;
  progress: WithdrawalProgressEvent[];
}> {
  const createdAt = new Date().toISOString();
  const initialProgress: WithdrawalProgressEvent[] = [
    {
      stage: 'request_created',
      message: 'Withdrawal request created.',
      at: createdAt,
      tx_hash: null
    }
  ];

  const insertWithProgress = () =>
    supabase
      .from('withdrawals')
      .insert({
        ...record,
        status: 'pending',
        created_at: createdAt,
        progress: initialProgress
      })
      .select('id,user_id,amount_usdt,destination_wallet,tx_hash,status,created_at,processed_at,progress')
      .single();

  let { data, error } = await insertWithProgress();
  if (error && /progress/i.test(error.message)) {
    const fallback = await supabase
      .from('withdrawals')
      .insert({
        ...record,
        status: 'pending',
        created_at: createdAt
      })
      .select('id,user_id,amount_usdt,destination_wallet,tx_hash,status,created_at,processed_at')
      .single();
    data = fallback.data as typeof data;
    error = fallback.error;
  }

  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error('Withdrawal insertion returned no row.');
  }

  const row = data as {
    id: string;
    user_id: string;
    amount_usdt: number | null;
    destination_wallet: string;
    tx_hash: string | null;
    status: string;
    created_at: string;
    processed_at: string | null;
    progress?: WithdrawalProgressEvent[] | null;
  };

  return {
    id: row.id,
    user_id: row.user_id,
    amount_usdt: Number(row.amount_usdt ?? 0),
    destination_wallet: row.destination_wallet,
    tx_hash: row.tx_hash ?? null,
    status: row.status,
    created_at: row.created_at,
    processed_at: row.processed_at ?? null,
    progress: row.progress ?? []
  };
}

export async function getWithdrawalStatusById(params: {
  user_id: string;
  withdrawal_id: string;
}): Promise<{
  id: string;
  amount_usdt: number;
  destination_wallet: string;
  tx_hash: string | null;
  status: string;
  created_at: string;
  processed_at: string | null;
  progress: WithdrawalProgressEvent[];
} | null> {
  const selectWithProgress = () =>
    supabase
      .from('withdrawals')
      .select('id,amount_usdt,destination_wallet,tx_hash,status,created_at,processed_at,progress')
      .eq('user_id', params.user_id)
      .eq('id', params.withdrawal_id)
      .maybeSingle();

  let { data, error } = await selectWithProgress();
  if (error && /progress/i.test(error.message)) {
    const fallback = await supabase
      .from('withdrawals')
      .select('id,amount_usdt,destination_wallet,tx_hash,status,created_at,processed_at')
      .eq('user_id', params.user_id)
      .eq('id', params.withdrawal_id)
      .maybeSingle();
    data = fallback.data as typeof data;
    error = fallback.error;
  }

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    amount_usdt: Number(data.amount_usdt ?? 0),
    destination_wallet: data.destination_wallet as string,
    tx_hash: (data.tx_hash as string | null) ?? null,
    status: data.status as string,
    created_at: data.created_at as string,
    processed_at: (data.processed_at as string | null) ?? null,
    progress: ((data.progress as WithdrawalProgressEvent[] | null) ?? []) as WithdrawalProgressEvent[]
  };
}

export async function updateWithdrawalRequest(record: {
  user_id: string;
  withdrawal_id: string;
  status: string;
  tx_hash?: string | null;
  processed_at?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: record.status
  };

  if (record.tx_hash !== undefined) {
    patch.tx_hash = record.tx_hash;
  }

  if (record.processed_at !== undefined) {
    patch.processed_at = record.processed_at;
  } else if (
    record.status === 'processed' ||
    record.status === 'completed' ||
    record.status === 'failed'
  ) {
    patch.processed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('withdrawals')
    .update(patch)
    .eq('id', record.withdrawal_id)
    .eq('user_id', record.user_id);

  if (error) {
    throw error;
  }
}

export async function appendWithdrawalProgress(record: {
  user_id: string;
  withdrawal_id: string;
  stage: string;
  message: string;
  tx_hash?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('progress')
    .eq('id', record.withdrawal_id)
    .eq('user_id', record.user_id)
    .maybeSingle();

  if (error && /progress/i.test(error.message)) {
    return;
  }
  if (error) {
    throw error;
  }

  const current = ((data?.progress as WithdrawalProgressEvent[] | null) ?? []) as WithdrawalProgressEvent[];
  const next = [
    ...current,
    {
      stage: record.stage,
      message: record.message,
      at: new Date().toISOString(),
      tx_hash: record.tx_hash ?? null,
      ...(record.details ? { details: record.details } : {})
    }
  ];

  const { error: updateError } = await supabase
    .from('withdrawals')
    .update({ progress: next })
    .eq('id', record.withdrawal_id)
    .eq('user_id', record.user_id);

  if (updateError) {
    throw updateError;
  }
}

export async function accrueManagementFeeDaily(rateBpsDaily = 1): Promise<number> {
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id,equity_usdt')
    .eq('is_active', true);

  if (usersError) {
    throw usersError;
  }

  const rows = (users ?? [])
    .map((user: any) => {
      const equity = Number(user.equity_usdt ?? 0);
      const fee = Number(((equity * rateBpsDaily) / 10_000).toFixed(6));
      if (fee <= 0) {
        return null;
      }
      return {
        user_id: user.id as string,
        fee_type: 'management',
        rate_bps: rateBpsDaily,
        amount_usdt: fee,
        period_start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        period_end: new Date().toISOString(),
        settled: false
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return 0;
  }

  const { error } = await supabase.from('fee_ledger').insert(rows);
  if (error) {
    throw error;
  }

  return rows.length;
}
