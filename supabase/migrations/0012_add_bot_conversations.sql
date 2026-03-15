create table if not exists bot_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  telegram_chat_id text not null,
  telegram_message_id bigint,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  context_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_bot_conversations_user_chat_created
  on bot_conversations(user_id, telegram_chat_id, created_at desc);

create index if not exists idx_bot_conversations_user_created
  on bot_conversations(user_id, created_at desc);
