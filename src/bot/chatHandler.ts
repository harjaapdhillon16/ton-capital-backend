import type { BotConversationTurn } from '../services/ai/chat.js';
import type { BotTradingContext } from '../services/bot/context.js';

export const ONBOARDING_BLOCK_MESSAGE =
  'I could not find an active TON Capital profile for this Telegram account. Complete onboarding in the Mini App first.';
export const TEMPORARY_ERROR_MESSAGE =
  'I hit a temporary issue while fetching your trading context. Please try again in a few seconds.';

export type PrivateTextMessageEvent = {
  chatType: string;
  text: string;
  telegramId: string;
  chatId: string;
  messageId: number;
  reply: (text: string) => Promise<unknown>;
};

export type BotChatDependencies = {
  getUserIdByTelegramId: (telegramId: string) => Promise<string | null>;
  buildBotTradingContext: (userId: string) => Promise<BotTradingContext>;
  appendBotConversationMessage: (record: {
    user_id: string;
    telegram_chat_id: string;
    telegram_message_id?: number | null;
    role: 'user' | 'assistant';
    content: string;
    context_snapshot?: Record<string, unknown> | null;
  }) => Promise<void>;
  getRecentBotConversationMessages: (params: {
    user_id: string;
    telegram_chat_id: string;
    limit?: number;
  }) => Promise<Array<{ role: 'user' | 'assistant'; content: string; created_at: string }>>;
  generateBotChatReply: (params: {
    userMessage: string;
    history: BotConversationTurn[];
    context: BotTradingContext;
  }) => Promise<string>;
};

function isCommandText(text: string): boolean {
  return text.trim().startsWith('/');
}

export async function handlePrivateTextMessage(
  event: PrivateTextMessageEvent,
  deps: BotChatDependencies,
  onError?: (error: Error, userId?: string) => void
): Promise<void> {
  const text = event.text.trim();
  if (event.chatType !== 'private' || !text || isCommandText(text)) {
    return;
  }

  const userId = await deps.getUserIdByTelegramId(event.telegramId);
  if (!userId) {
    await event.reply(ONBOARDING_BLOCK_MESSAGE);
    return;
  }

  await deps.appendBotConversationMessage({
    user_id: userId,
    telegram_chat_id: event.chatId,
    telegram_message_id: event.messageId,
    role: 'user',
    content: text,
    context_snapshot: null
  });

  let answer = TEMPORARY_ERROR_MESSAGE;
  let contextSnapshot: Record<string, unknown> | null = null;

  try {
    const context = await deps.buildBotTradingContext(userId);
    contextSnapshot = context as unknown as Record<string, unknown>;
    const history = await deps.getRecentBotConversationMessages({
      user_id: userId,
      telegram_chat_id: event.chatId,
      limit: 12
    });

    answer = await deps.generateBotChatReply({
      userMessage: text,
      history: history.map((item) => ({
        role: item.role,
        content: item.content
      })),
      context
    });
  } catch (error) {
    onError?.(error as Error, userId);
  }

  try {
    await deps.appendBotConversationMessage({
      user_id: userId,
      telegram_chat_id: event.chatId,
      telegram_message_id: null,
      role: 'assistant',
      content: answer,
      context_snapshot: contextSnapshot
    });
  } catch (error) {
    onError?.(error as Error, userId);
  }

  await event.reply(answer);
}
