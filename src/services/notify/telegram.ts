import { getConfig } from '../../config.js';

export async function sendTradeNotification(
  telegramId: string,
  payload: {
    asset: string;
    action: string;
    position_pct: number;
    stop_loss_pct: number;
    thesis: string;
    invalidation: string;
    explanation_for_user: string;
    balance_usdt: number;
  }
): Promise<void> {
  const emoji =
    payload.action === 'OPEN_LONG'
      ? '📈'
      : payload.action === 'OPEN_SHORT'
        ? '📉'
        : payload.action === 'CLOSE'
          ? '💰'
          : '👀';

  const text = [
    `${emoji} TON Capital AI acted on your portfolio`,
    `Asset: ${payload.asset}`,
    `Action: ${payload.action.replace('_', ' ')}`,
    `Position: ${payload.position_pct}%`,
    `Stop-loss: ${payload.stop_loss_pct}%`,
    `Thesis: ${payload.thesis}`,
    `Invalidation: ${payload.invalidation}`,
    `Why: ${payload.explanation_for_user}`,
    `Balance: ${payload.balance_usdt.toFixed(2)} USDT`
  ].join('\n');

  const response = await fetch(
    `https://api.telegram.org/bot${getConfig().TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        disable_web_page_preview: true
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram notification failed: ${response.status} ${err}`);
  }
}
