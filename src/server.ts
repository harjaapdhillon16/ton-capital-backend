import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './logger.js';
import { v1Router } from './api/routes/v1.js';

export function createServer() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '1mb' }));
  const httpLogger = (pinoHttp as unknown as (options: { logger: typeof logger }) => express.RequestHandler)({
    logger
  });
  app.use(httpLogger);

  app.use('/v1', v1Router);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
