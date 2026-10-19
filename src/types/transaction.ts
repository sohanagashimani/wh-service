import { z } from 'zod';

export type TransactionStatus = 'PROCESSING' | 'PROCESSED';

export interface TransactionRecord {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  is_scheduled: boolean;
  scheduled_at: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface TransactionResponse {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  created_at: string;
  processed_at: string | null;
}

export const transactionWebhookSchema = z.object({
  transaction_id: z
    .string({ required_error: 'transaction_id is required' })
    .trim()
    .min(1, 'transaction_id cannot be empty'),
  source_account: z
    .string({ required_error: 'source_account is required' })
    .trim()
    .min(1, 'source_account cannot be empty'),
  destination_account: z
    .string({ required_error: 'destination_account is required' })
    .trim()
    .min(1, 'destination_account cannot be empty'),
  amount: z
    .number({ required_error: 'amount is required' })
    .positive('amount must be greater than zero')
    .finite('amount must be a finite number')
    .refine(
      (val) => {
        // Decimal-safe validation: allow at most 2 decimal places
        const parts = val.toString().split('.');
        return parts.length < 2 || (parts[1]?.length ?? 0) <= 2;
      },
      { message: 'amount cannot exceed 2 decimal places' }
    ),
  currency: z
    .string({ required_error: 'currency is required' })
    .trim()
    .length(3, 'currency must be a 3-letter currency code')
    .toUpperCase(),
});

export type TransactionWebhookInput = z.infer<typeof transactionWebhookSchema>;

export const processTaskPayloadSchema = z.object({
  transaction_id: z
    .string({ required_error: 'transaction_id is required' })
    .trim()
    .min(1, 'transaction_id cannot be empty'),
});

export type ProcessTaskPayload = z.infer<typeof processTaskPayloadSchema>;
