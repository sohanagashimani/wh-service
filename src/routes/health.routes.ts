import { Router, Request, Response } from 'express';

export const healthRouter = Router();

/**
 * Health check endpoint.
 * Returns HTTP 200 with current UTC ISO 8601 timestamp.
 */
healthRouter.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'HEALTHY',
    current_time: new Date().toISOString(),
  });
});
