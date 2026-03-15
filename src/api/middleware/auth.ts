import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../../config.js';
import { getUserIdByTelegramId } from '../../db/repository.js';
import { validateTelegramInitData } from '../../utils/telegramAuth.js';

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const allowUnknownUser = req.path === '/onboarding/complete' || req.path === '/user/exists';
  const authHeader = req.header('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return;
  }

  if (token === 'dev-token' && getConfig().NODE_ENV !== 'production') {
    const telegramId = (process.env.DEV_TELEGRAM_ID ?? '').trim();
    const explicitUserId = (process.env.DEV_USER_ID ?? '').trim();
    const resolvedUserId =
      explicitUserId || (telegramId ? await getUserIdByTelegramId(telegramId) : null);

    req.auth = {
      userId: resolvedUserId,
      telegramId: telegramId || 'dev-telegram-id-not-set',
      username: process.env.DEV_TELEGRAM_USERNAME ?? null,
      firstName: process.env.DEV_TELEGRAM_FIRST_NAME ?? 'Dev',
      lastName: process.env.DEV_TELEGRAM_LAST_NAME ?? 'User'
    };
    next();
    return;
  }

  try {
    const parsed = validateTelegramInitData(token, getConfig().TELEGRAM_BOT_TOKEN);
    const telegramId = parsed.telegram_id.trim();
    const userId = await getUserIdByTelegramId(telegramId);
    if (!userId && !allowUnknownUser) {
      res.status(401).json({ error: `Unknown user for telegram_id=${telegramId}. Authenticate first.` });
      return;
    }

    req.auth = {
      userId: userId ?? null,
      telegramId,
      username: parsed.username ?? null,
      firstName: parsed.first_name ?? null,
      lastName: parsed.last_name ?? null
    };
    next();
  } catch (error) {
    res.status(401).json({ error: (error as Error).message });
  }
}
