import { getConfig } from '../../config.js';

export async function getWhaleFlows(): Promise<
  Array<{
    wallet: string;
    asset: string;
    direction: 'inflow' | 'outflow';
    amount_usd: number;
    timestamp: string;
  }>
> {
  const payload = {
    id: 1,
    jsonrpc: '2.0',
    method: 'getTransactions',
    params: {
      account: getConfig().AGENT_WALLET_ADDRESS,
      limit: 5
    }
  };

  const response = await fetch(getConfig().TONCENTER_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getConfig().TONCENTER_API_KEY
        ? {
            'X-API-Key': getConfig().TONCENTER_API_KEY
          }
        : {})
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return [];
  }

  const json = (await response.json()) as { result?: Array<{ utime: number; fee: string }> };

  return (json.result ?? []).map((item) => ({
    wallet: getConfig().AGENT_WALLET_ADDRESS,
    asset: 'TON',
    direction: 'outflow' as const,
    amount_usd: Number(item.fee) / 1_000_000_000,
    timestamp: new Date(item.utime * 1000).toISOString()
  }));
}
