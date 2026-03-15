# TON Capital Agent Backend

Node.js runtime for autonomous strategy loop, risk controls, execution, and Telegram notifications.

## Core capabilities

- REST API for Telegram Mini App
- 15-minute orchestration loop with distributed lock
- DeepSeek reasoning with strict JSON schema validation
- Risk gating and idempotent trade execution
- grammy bot commands for control and status
- Telegram chat assistant replies with per-user trading context
- Supabase persistence and audit trail

## API (Mini App)

- `POST /v1/auth/telegram` authenticate signed Telegram `initData`
- `GET /v1/me` fetch user + onboarding + risk profile snapshot
- `POST /v1/onboarding/complete` persist onboarding state and provision encrypted per-user trade wallet
- `POST /v1/deposit/intent`, `GET /v1/portfolio`, `GET /v1/positions`, `GET /v1/agent-feed`

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

## Trade wallet custody

- `POST /v1/onboarding/complete` ensures each user has an app-managed trade wallet.
- Wallet mnemonic is encrypted at rest using a key derived from `AGENT_WALLET_MNEMONIC` + `AGENT_WALLET_ADDRESS`.
- `POST /v1/deposit/intent` returns a TON payment quote and agent settlement wallet.
- `POST /v1/deposit/submitted` triggers TON -> USDT settlement:
  - `DEPOSIT_SETTLEMENT_MODE=ston_auto`: automatic swap via STON.fi, then USDT transfer to user trade wallet.
  - `DEPOSIT_SETTLEMENT_MODE=swap_webhook`: delegate conversion to your webhook.
  - `DEPOSIT_SETTLEMENT_MODE=treasury_usdt`: direct treasury payout fallback.

## Deployment

- Build container from this service
- Deploy to Railway/Render or any Node container runtime
- Set all environment variables from `.env.example`
