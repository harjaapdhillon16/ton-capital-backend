import pino from 'pino';
import { getConfig } from './config.js';

export const logger = pino({
  name: 'ton-capital-agent',
  level: getConfig().LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});
