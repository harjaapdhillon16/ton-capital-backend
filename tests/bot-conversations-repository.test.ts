import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn()
}));

vi.mock('../src/db/client.js', () => ({
  supabase: {
    from: fromMock
  }
}));

describe('bot conversation repository', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('inserts bot conversation records', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    fromMock.mockReturnValue({ insert });

    const { appendBotConversationMessage } = await import('../src/db/repository.js');

    await appendBotConversationMessage({
      user_id: 'u1',
      telegram_chat_id: 'c1',
      telegram_message_id: 11,
      role: 'user',
      content: 'hello',
      context_snapshot: null
    });

    expect(fromMock).toHaveBeenCalledWith('bot_conversations');
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('returns recent messages oldest-to-newest for prompt assembly', async () => {
    const rows = [
      { role: 'assistant', content: 'latest', created_at: '2026-03-15T10:00:00.000Z' },
      { role: 'user', content: 'older', created_at: '2026-03-15T09:00:00.000Z' }
    ];

    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(async () => ({ data: rows, error: null }))
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);

    fromMock.mockReturnValue(chain);

    const { getRecentBotConversationMessages } = await import('../src/db/repository.js');
    const result = await getRecentBotConversationMessages({
      user_id: 'u1',
      telegram_chat_id: 'c1',
      limit: 10
    });

    expect(result).toEqual([
      { role: 'user', content: 'older', created_at: '2026-03-15T09:00:00.000Z' },
      { role: 'assistant', content: 'latest', created_at: '2026-03-15T10:00:00.000Z' }
    ]);
  });
});
