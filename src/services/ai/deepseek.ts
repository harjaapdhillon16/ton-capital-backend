import {
  BRIEFING_STALE_MS,
  MIN_CONVICTION_SCORE,
  MIN_RISK_REWARD,
  MVP_ASSETS
} from '../../constants/trading.js';
import type { MvpAsset } from '../../constants/trading.js';
import { getConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { aiDecisionArraySchema, type AiDecision, type MarketBriefing } from '../../types/ai.js';
import { sleep } from '../../utils/time.js';

function hasUsableMarketContext(briefing: MarketBriefing): boolean {
  if (Object.keys(briefing.prices).length === 0) {
    return false;
  }

  const populatedContext = Object.values(briefing.market_context ?? {}).filter(Boolean).length;
  return populatedContext > 0;
}

function isBriefingStale(briefing: MarketBriefing): boolean {
  const ts = new Date(briefing.timestamp).getTime();
  if (!Number.isFinite(ts)) {
    return true;
  }
  return Date.now() - ts > BRIEFING_STALE_MS;
}

function buildPrompt(briefing: MarketBriefing): string {
  return [
    `Timestamp: ${briefing.timestamp}`,
    'You are the autonomous investment analyst for TON Capital AI.',
    'Return a JSON object ONLY with key "decisions".',
    'Schema for each decision:',
    '{asset, action, conviction, conviction_score, risk_reward, thesis, invalidation, position_pct, stop_loss_pct, take_profit_pct, explanation_for_user}',
    'Allowed actions: OPEN_LONG, OPEN_SHORT, CLOSE, HOLD.',
    `Assets must come from: ${MVP_ASSETS.join(', ')}.`,
    `Hard requirements for actionable signals: conviction_score >= ${MIN_CONVICTION_SCORE} and risk_reward >= ${MIN_RISK_REWARD}.`,
    'Use lowercase conviction values: high | medium | low.',
    'Keep position_pct between 1 and 15, stop_loss_pct between 1 and 8, take_profit_pct between 1 and 20.',
    'Never include markdown.',
    'Market briefing JSON:',
    JSON.stringify(briefing)
  ].join('\n');
}

export function holdFallback(reason: string): AiDecision[] {
  return MVP_ASSETS.slice(0, 4).map((asset) => ({
    asset,
    action: 'HOLD',
    conviction: 'low',
    conviction_score: 1,
    risk_reward: 0,
    thesis: reason,
    invalidation: 'Next successful decision cycle.',
    position_pct: 0,
    stop_loss_pct: 2,
    take_profit_pct: 4,
    explanation_for_user: 'No action was taken this cycle due to reliability guardrails.'
  }));
}

function normalizeConvictionScore(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input >= 0 && input <= 1) {
      return Math.round(input * 10);
    }
    if (input > 1 && input <= 10) {
      return Math.round(input);
    }
    if (input > 10 && input <= 100) {
      return Math.round(input / 10);
    }
  }

  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'high') return 9;
  if (value === 'medium' || value === 'moderate' || value === 'med') return 6;
  if (value === 'low') return 3;
  return 1;
}

function normalizeConviction(input: unknown, convictionScore: number): 'high' | 'medium' | 'low' {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'high') {
    return 'high';
  }
  if (value === 'medium' || value === 'moderate' || value === 'med') {
    return 'medium';
  }
  if (value === 'low') {
    return 'low';
  }

  if (convictionScore >= 8) {
    return 'high';
  }
  if (convictionScore >= 5) {
    return 'medium';
  }
  return 'low';
}

function normalizeAction(input: unknown): string {
  const raw = String(input ?? '').trim().toUpperCase();
  if (raw === 'LONG') return 'OPEN_LONG';
  if (raw === 'SHORT') return 'OPEN_SHORT';
  if (raw === 'EXIT') return 'CLOSE';
  return raw;
}

function normalizeNumber(input: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Number(Math.min(max, Math.max(min, parsed)).toFixed(4));
}

function normalizeRiskReward(input: unknown): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Number(Math.max(0, parsed).toFixed(4));
}

function normalizeAsset(input: unknown): MvpAsset {
  const normalized = String(input ?? '').toUpperCase().replace('/', '').replace('-', '').trim();
  if (normalized === 'XAU') {
    return 'XAUUSD';
  }
  if (normalized === 'XAUUSD') {
    return 'XAUUSD';
  }
  if (normalized === 'EURUSD') {
    return 'EURUSD';
  }
  if (MVP_ASSETS.includes(normalized as MvpAsset)) {
    return normalized as MvpAsset;
  }
  return 'BTC';
}

export function normalizeDecisionCandidate(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return item;
  }

  const row = item as Record<string, unknown>;
  const convictionScore = normalizeConvictionScore(row.conviction_score ?? row.conviction);

  return {
    ...row,
    asset: normalizeAsset(row.asset),
    action: normalizeAction(row.action),
    conviction_score: normalizeNumber(convictionScore, 1, 1, 10),
    conviction: normalizeConviction(row.conviction, convictionScore),
    risk_reward: normalizeRiskReward(row.risk_reward ?? row.rr),
    thesis: String(row.thesis ?? '').trim() || 'No thesis provided by model.',
    invalidation: String(row.invalidation ?? '').trim() || 'No invalidation provided by model.',
    explanation_for_user:
      String(row.explanation_for_user ?? '').trim() ||
      'Model response did not include an explanation.',
    position_pct: normalizeNumber(row.position_pct, 1, 0, 25),
    stop_loss_pct: normalizeNumber(row.stop_loss_pct, 2, 0.5, 20),
    take_profit_pct: normalizeNumber(row.take_profit_pct, 4, 0.5, 50)
  };
}

function enforceSignalQuality(decisions: AiDecision[]): AiDecision[] {
  return decisions.map((decision) => {
    if (decision.action === 'HOLD') {
      return decision;
    }

    if (decision.conviction_score < MIN_CONVICTION_SCORE || decision.risk_reward < MIN_RISK_REWARD) {
      return {
        ...decision,
        action: 'HOLD',
        explanation_for_user:
          'Signal quality gate blocked execution: conviction or risk-reward threshold was not met.',
        position_pct: 0
      };
    }

    return decision;
  });
}

export async function analyzeWithDeepSeek(briefing: MarketBriefing): Promise<AiDecision[]> {
  if (isBriefingStale(briefing)) {
    logger.warn('Briefing stale; forcing HOLD fallback');
    return holdFallback('Market briefing stale.');
  }

  if (!hasUsableMarketContext(briefing)) {
    logger.warn('Briefing lacks usable market context; forcing HOLD fallback');
    return holdFallback('Insufficient market data for safe execution.');
  }

  const config = getConfig();
  const maxAttempts = 3;
  let lastError: Error | null = null;

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
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a risk-aware macro and crypto analyst. Return only machine-parseable JSON object under key decisions.'
            },
            {
              role: 'user',
              content: buildPrompt(briefing)
            }
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
        throw new Error('DeepSeek response missing content.');
      }

      const parsedRoot = JSON.parse(content) as { decisions?: unknown };
      const decisionsRaw = parsedRoot.decisions;

      const normalized = (Array.isArray(decisionsRaw) ? decisionsRaw : []).map(normalizeDecisionCandidate);
      const parsed = aiDecisionArraySchema.parse(normalized);
      return enforceSignalQuality(parsed);
    } catch (error) {
      lastError = error as Error;
      logger.warn({ attempt, err: lastError.message }, 'DeepSeek call failed; retrying');
      await sleep(300 * 2 ** attempt);
    }
  }

  logger.error({ err: lastError?.message }, 'DeepSeek failed all retries; fallback to HOLD set');
  return holdFallback('Model response failed validation.');
}
