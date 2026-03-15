# Mainnet Launch Runbook

## Pre-launch checks

1. Apply Supabase migrations and verify `system_controls` row exists.
2. Deploy contracts on testnet and verify deposit/withdraw invariants.
3. Deploy backend in staging with real API keys and KMS signer.
4. Set `system_controls.trading_enabled = false` before first mainnet deploy.
5. Run smoke flow: `/v1/health`, Telegram `/start`, deposit intent, dry-run agent cycle.

## Launch sequence

1. Deploy mainnet contracts and store `VAULT_FACTORY_ADDRESS`.
2. Deploy backend + bot.
3. Enable kill-switch caps (`launch_cap_enabled = true`, low global cap).
4. Set `trading_enabled = true`.
5. Monitor logs/alerts continuously for first 24h.

## Rollback

1. Set `trading_enabled = false`.
2. Trigger `/pause` broadcast to all users.
3. Stop scheduler tasks.
4. Keep close-only operations enabled until all high-risk exposure is reduced.
