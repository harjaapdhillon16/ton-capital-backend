import crypto from 'node:crypto';

function parseInitData(initData: string): URLSearchParams {
  return new URLSearchParams(initData);
}

function getDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') {
      continue;
    }
    pairs.push(`${key}=${value}`);
  }
  pairs.sort((a, b) => a.localeCompare(b));
  return pairs.join('\n');
}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 3600
): {
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
} {
  const params = parseInitData(initData);
  const providedHash = params.get('hash');
  const authDate = Number(params.get('auth_date') ?? 0);

  if (!providedHash || !authDate) {
    throw new Error('Missing hash/auth_date in Telegram initData.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw new Error('Telegram initData is expired.');
  }

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const checkString = getDataCheckString(params);
  const calculatedHash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  if (calculatedHash !== providedHash) {
    throw new Error('Invalid Telegram initData hash.');
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    throw new Error('Missing Telegram user object.');
  }

  const parsed = JSON.parse(userRaw) as {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };

  return {
    telegram_id: String(parsed.id),
    username: parsed.username ?? null,
    first_name: parsed.first_name ?? null,
    last_name: parsed.last_name ?? null
  };
}
