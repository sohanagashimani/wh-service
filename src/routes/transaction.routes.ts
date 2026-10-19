import { Router, Request, Response, NextFunction } from 'express';
import { transactionService } from '../services/transaction.service.js';
import { transactionWebhookSchema } from '../types/transaction.js';

export const transactionRouter = Router();

/**
 * Transaction Webhook Endpoint
 * POST /v1/webhooks/transactions
 * Accepts transaction webhook, persists it, schedules Cloud Task, and returns 202 promptly.
 */
transactionRouter.post(
  '/webhooks/transactions',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate incoming JSON body against schema
      const validatedPayload = transactionWebhookSchema.parse(req.body);

      // Persist and schedule task idempotently
      const result = await transactionService.handleWebhook(validatedPayload);

      // Return HTTP 202 Accepted without waiting for background execution
      res.status(202).json({
        status: result.status,
        message: result.message,
        transaction_id: result.transaction_id,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Transaction Status Endpoint
 * GET /v1/transactions/:transaction_id
 * Returns current status and transaction details, or 404 if not found.
 */
transactionRouter.get(
  '/transactions/:transaction_id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transactionIdParam = req.params['transaction_id'];
      const transactionId = Array.isArray(transactionIdParam)
        ? transactionIdParam[0]
        : transactionIdParam;

      if (!transactionId || typeof transactionId !== 'string' || transactionId.trim().length === 0) {
        res.status(400).json({ error: 'transaction_id is required' });
        return;
      }

      const transaction = await transactionService.getTransactionById(transactionId.trim());

      if (!transaction) {
        res.status(404).json({
          error: `Transaction not found: ${transactionId}`,
        });
        return;
      }

      res.status(200).json(transaction);
    } catch (error) {
      next(error);
    }
  }
);
