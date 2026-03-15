import { getConfig } from '../../config.js';

export async function getFearGreed(): Promise<{ value: number; classification: string }> {
  const response = await fetch(getConfig().FEAR_GREED_URL, {
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Fear & Greed request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{ value: string; value_classification: string }>;
  };

  const row = data.data[0];
  if (!row) {
    throw new Error('Fear & Greed response did not contain data rows.');
  }

  return {
    value: Number(row.value),
    classification: row.value_classification
  };
}
