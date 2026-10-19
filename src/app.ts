import express, { Express, Request, Response } from 'express';
import { healthRouter } from './routes/health.routes.js';
import { transactionRouter } from './routes/transaction.routes.js';
import { internalRouter } from './routes/internal.routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { logger } from './lib/logger.js';

export function createApp(): Express {
  const app = express();

  // Parse JSON payloads
  app.use(express.json({ limit: '1mb' }));

  // Basic request logger
  app.use((req: Request, res: Response, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      logger.debug('HTTP request completed', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
      });
    });
    next();
  });

  // Mount API Routers
  app.use('/', healthRouter);
  app.use('/v1', transactionRouter);
  app.use('/internal', internalRouter);

  // Handle unmatched routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
