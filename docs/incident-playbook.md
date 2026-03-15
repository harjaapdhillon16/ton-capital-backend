# Incident Playbook

## DeepSeek outage

- Symptom: repeated AI request failures.
- Mitigation: fallback HOLD decisions are automatic.
- Action: keep trading enabled only for CLOSE operations if manual override is needed.

## Storm execution errors

- Symptom: high `trades.status = failed`.
- Action: enable global kill switch.
- Action: inspect provider/network health and resume gradually.

## Signer/KMS failure

- Symptom: signing errors from Lambda/KMS.
- Action: disable trading globally.
- Action: rotate IAM credentials and verify KMS key policy.

## Data feed drift

- Symptom: stale oracle/news timestamps.
- Action: reject OPEN actions for that cycle.
- Action: resume only after data freshness checks pass.
