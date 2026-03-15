import crypto from 'node:crypto';
import type { AiDecision } from '../types/ai.js';

export function makeIdempotencyKey(runId: string, userId: string, decision: AiDecision): string {
  const input = `${runId}:${userId}:${decision.asset}:${decision.action}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}
