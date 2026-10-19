import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { taskService } from './task.service.js';
import {
  TransactionRecord,
  TransactionResponse,
  TransactionWebhookInput,
} from '../types/transaction.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TransactionService {
  /**
   * Transforms a database record to the public API response format.
   */
  private mapToResponse(record: TransactionRecord): TransactionResponse {
    return {
      transaction_id: record.transaction_id,
      source_account: record.source_account,
      destination_account: record.destination_account,
      amount: typeof record.amount === 'number' ? record.amount : Number(record.amount),
      currency: record.currency,
      status: record.status,
      created_at: record.created_at,
      processed_at: record.processed_at,
    };
  }

  /**
   * Handles incoming transaction webhook.
   * Ensures idempotency:
   * 1. Inserts into database or detects duplicate via unique constraint.
   * 2. Schedules Cloud Task with 30-second delay.
   * 3. Recovers failed scheduling if a duplicate webhook arrives for an unscheduled transaction.
   */
  async handleWebhook(input: TransactionWebhookInput): Promise<{
    status: string;
    message: string;
    transaction_id: string;
  }> {
    logger.info('Processing webhook for transaction', {
      transaction_id: input.transaction_id,
      amount: input.amount,
      currency: input.currency,
    });

    let isDuplicate = false;
    let existingRecord: TransactionRecord | null = null;

    // Step 1: Attempt to persist the transaction record
    const { data: insertedData, error: insertError } = await supabase
      .from('transactions')
      .insert({
        transaction_id: input.transaction_id,
        source_account: input.source_account,
        destination_account: input.destination_account,
        amount: input.amount,
        currency: input.currency,
        status: 'PROCESSING',
        is_scheduled: false,
        scheduled_at: null,
      })
      .select()
      .single();

    if (insertError) {
      // Postgres error 23505: unique_violation
      if (insertError.code === '23505') {
        isDuplicate = true;
        logger.info('Duplicate webhook detected for transaction', {
          transaction_id: input.transaction_id,
        });

        // Fetch existing transaction state
        const { data: fetched, error: fetchError } = await supabase
          .from('transactions')
          .select('*')
          .eq('transaction_id', input.transaction_id)
          .single();

        if (fetchError || !fetched) {
          logger.error('Failed to retrieve existing duplicate transaction', {
            transaction_id: input.transaction_id,
            error: fetchError?.message,
          });
          throw new AppError(500, 'Database error while verifying existing transaction');
        }

        existingRecord = fetched as TransactionRecord;
      } else {
        logger.error('Database error while inserting transaction', {
          transaction_id: input.transaction_id,
          error: insertError.message,
        });
        throw new AppError(500, 'Failed to persist transaction');
      }
    }

    // If duplicate and already processed, return accepted immediately without creating duplicate tasks
    if (isDuplicate && existingRecord) {
      if (existingRecord.status === 'PROCESSED') {
        logger.info('Transaction is already PROCESSED. Skipping task creation.', {
          transaction_id: input.transaction_id,
        });
        return {
          status: 'ACCEPTED',
          message: 'Transaction already processed',
          transaction_id: input.transaction_id,
        };
      }

      // If duplicate and already successfully scheduled, return accepted immediately
      if (existingRecord.status === 'PROCESSING' && existingRecord.is_scheduled) {
        logger.info('Transaction task is already scheduled. Skipping duplicate task creation.', {
          transaction_id: input.transaction_id,
        });
        return {
          status: 'ACCEPTED',
          message: 'Transaction already accepted and scheduled for processing',
          transaction_id: input.transaction_id,
        };
      }

      // If duplicate but is_scheduled is false (e.g. prior scheduling failed), we proceed below to attempt scheduling!
      logger.info('Transaction exists but task was not successfully scheduled. Attempting recovery.', {
        transaction_id: input.transaction_id,
      });
    }

    // Step 2: Schedule Cloud Task for 30s delayed execution
    try {
      const scheduleResult = await taskService.scheduleTransactionProcessing(input.transaction_id, 30);

      // Step 3: Mark transaction as scheduled in database
      const { error: updateError } = await supabase
        .from('transactions')
        .update({
          is_scheduled: true,
          scheduled_at: scheduleResult.scheduledTime,
        })
        .eq('transaction_id', input.transaction_id);

      if (updateError) {
        logger.warn('Failed to update is_scheduled flag in database after successful task scheduling', {
          transaction_id: input.transaction_id,
          error: updateError.message,
        });
        // We do not fail the request here because the background task WAS successfully enqueued.
      }

      return {
        status: 'ACCEPTED',
        message: 'Transaction accepted and scheduled for processing',
        transaction_id: input.transaction_id,
      };
    } catch (taskError: unknown) {
      logger.error('Failed to schedule Cloud Task for transaction', {
        transaction_id: input.transaction_id,
        error: taskError instanceof Error ? taskError.message : String(taskError),
      });

      // Do NOT return a misleading 202 if task creation failed.
      // The row remains in DB with is_scheduled = false, so the next webhook retry can reschedule it.
      throw new AppError(
        503,
        'Transaction recorded but background task scheduling failed. Please retry.'
      );
    }
  }

  /**
   * Retrieves transaction by ID.
   */
  async getTransactionById(transactionId: string): Promise<TransactionResponse | null> {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (error) {
      logger.error('Error fetching transaction by ID', {
        transaction_id: transactionId,
        error: error.message,
      });
      throw new AppError(500, 'Database error while retrieving transaction');
    }

    if (!data) {
      return null;
    }

    return this.mapToResponse(data as TransactionRecord);
  }

  /**
   * Internal processor invoked by Cloud Tasks.
   * Performs idempotent state transition and simulated external operation.
   */
  async processTransaction(transactionId: string): Promise<{
    status: 'PROCESSED' | 'ALREADY_PROCESSED';
    transaction_id: string;
    processed_at: string;
  }> {
    logger.info('Starting background transaction processing', {
      transaction_id: transactionId,
    });

    // 1. Fetch current transaction record
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (error) {
      logger.error('Failed to fetch transaction for processing', {
        transaction_id: transactionId,
        error: error.message,
      });
      throw new AppError(500, 'Transient database error while fetching transaction');
    }

    if (!data) {
      logger.warn('Transaction not found for processing task', {
        transaction_id: transactionId,
      });
      throw new AppError(404, `Transaction not found: ${transactionId}`);
    }

    const transaction = data as TransactionRecord;

    // 2. Idempotency check: if already processed, return success immediately
    if (transaction.status === 'PROCESSED') {
      logger.info('Transaction already PROCESSED. Skipping duplicate execution.', {
        transaction_id: transactionId,
        processed_at: transaction.processed_at,
      });
      return {
        status: 'ALREADY_PROCESSED',
        transaction_id: transactionId,
        processed_at: transaction.processed_at || new Date().toISOString(),
      };
    }

    // 3. Simulate external API operation (lightweight placeholder operation, NO 30s sleep!)
    await this.simulateExternalApiOperation(transaction);

    // 4. Atomic conditional update to mark as PROCESSED
    const completionTime = new Date().toISOString();
    const { data: updatedRecord, error: updateError } = await supabase
      .from('transactions')
      .update({
        status: 'PROCESSED',
        processed_at: completionTime,
      })
      .eq('transaction_id', transactionId)
      .eq('status', 'PROCESSING') // Atomic condition prevents race conditions
      .select()
      .maybeSingle();

    if (updateError) {
      logger.error('Failed to update transaction status to PROCESSED', {
        transaction_id: transactionId,
        error: updateError.message,
      });
      throw new AppError(500, 'Failed to update transaction status in database');
    }

    if (!updatedRecord) {
      // Another concurrent delivery may have completed it right before this update
      logger.warn('Transaction was not updated by this worker (concurrent worker likely completed it)', {
        transaction_id: transactionId,
      });
      return {
        status: 'ALREADY_PROCESSED',
        transaction_id: transactionId,
        processed_at: completionTime,
      };
    }

    logger.info('Transaction processing completed successfully', {
      transaction_id: transactionId,
      status: 'PROCESSED',
      processed_at: completionTime,
    });

    return {
      status: 'PROCESSED',
      transaction_id: transactionId,
      processed_at: completionTime,
    };
  }

  /**
   * Lightweight simulated external operation placeholder.
   */
  private async simulateExternalApiOperation(transaction: TransactionRecord): Promise<void> {
    // Perform lightweight placeholder operation: log and verify accounts
    logger.info('Simulating external payment processor settlement', {
      transaction_id: transaction.transaction_id,
      source: transaction.source_account,
      destination: transaction.destination_account,
      amount: transaction.amount,
      currency: transaction.currency,
    });

    // Small async yield to simulate I/O without any artificial 30s delay
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export const transactionService = new TransactionService();
