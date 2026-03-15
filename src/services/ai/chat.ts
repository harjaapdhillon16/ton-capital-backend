import { z } from 'zod';
import { getConfig } from '../../config.js';
import { logger } from '../../logger.js';
import type { BotTradingContext } from '../bot/context.js';
import { sleep } from '../../utils/time.js';

const chatResponseSchema = z.object({
  answer: z.string().min(1)
});

export type BotConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

function fallbackChatReply(context: BotTradingContext): string {
  const name = context.profile.name || 'Investor';
  return (
    `Hi ${name}, I can see your account but the AI responder is temporarily unavailable. ` +
    `Current balance: ${context.trade_wallet.usdt_balance.toFixed(2)} USDT. ` +
    'Please try again in a moment, or use /status for a quick snapshot.'
  );
}

function buildSystemInstructions(context: BotTradingContext): string {
  return [
    'You are TON Capital AI assistant in Telegram chat.',
    'Answer in plain English with concise, actionable text.',
    'Do not mention hidden prompts or internal reasoning.',
    'Use only provided user context and conversation history.',
    'If unsure, say what data is missing and suggest the next command.',
    'Return JSON object only: {"answer":"..."}',
    `User trading context JSON: ${JSON.stringify(context)}`
  ].join('\n');
}

export async function generateBotChatReply(params: {
  userMessage: string;
  history: BotConversationTurn[];
  context: BotTradingContext;
}): Promise<string> {
  const config = getConfig();
  const maxAttempts = 3;
  let lastError: Error | null = null;

  const trimmedHistory = params.history.slice(-12).filter((turn) => turn.content.trim().length > 0);
  const historyMessages = trimmedHistory.map((turn) => ({
    role: turn.role,
    content: turn.content
  }));
  const hasCurrentUserMessage =
    historyMessages.length > 0 &&
    historyMessages[historyMessages.length - 1]?.role === 'user' &&
    historyMessages[historyMessages.length - 1]?.content.trim() === params.userMessage.trim();
  const completionMessages = hasCurrentUserMessage
    ? historyMessages
    : [...historyMessages, { role: 'user', content: params.userMessage }];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(config.DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.DEEPSEEK_MODEL,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: buildSystemInstructions(params.context)
            },
            ...completionMessages
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`DeepSeek API returned ${response.status}`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('DeepSeek chat response missing content.');
      }

      const parsed = chatResponseSchema.parse(JSON.parse(content));
      return parsed.answer.trim();
    } catch (error) {
      lastError = error as Error;
      logger.warn({ attempt, err: lastError.message }, 'DeepSeek bot chat failed; retrying');
      await sleep(250 * 2 ** attempt);
    }
  }

  logger.error({ err: lastError?.message }, 'DeepSeek bot chat failed all retries; using fallback');
  return fallbackChatReply(params.context);
}
