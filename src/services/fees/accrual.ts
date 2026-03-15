import { accrueManagementFeeDaily } from '../../db/repository.js';
import { logger } from '../../logger.js';

export async function runDailyFeeAccrual(): Promise<void> {
  const entries = await accrueManagementFeeDaily(1);
  logger.info({ entries }, 'Daily management fee accrual completed');
}
