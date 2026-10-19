import { Router, Request, Response, NextFunction } from 'express';
import { verifyTaskAuth } from '../middleware/task-auth.js';
import { transactionService } from '../services/transaction.service.js';
import { processTaskPayloadSchema } from '../types/transaction.js';

export const internalRouter = Router();

/**
 * Internal Background Processing Task Handler
 * POST /internal/process-transaction
 * Invoked by Google Cloud Tasks to execute background settlement.
 */
internalRouter.post(
  '/process-transaction',
  verifyTaskAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate incoming Cloud Task payload
      const { transaction_id } = processTaskPayloadSchema.parse(req.body);

      // Process transaction idempotently
      const result = await transactionService.processTransaction(transaction_id);

      // Return 200 to acknowledge task completion to Cloud Tasks
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);
