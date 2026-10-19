-- Migration: 001_create_transactions.sql
-- Description: Create transactions table with constraints and indexes for idempotency and status tracking

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    source_account TEXT NOT NULL,
    destination_account TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL CHECK (char_length(currency) = 3),
    status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'PROCESSED')),
    is_scheduled BOOLEAN NOT NULL DEFAULT FALSE,
    scheduled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    processed_at TIMESTAMPTZ
);

-- Index for status queries and monitoring
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- Comments on table and columns for documentation
COMMENT ON TABLE transactions IS 'Persistent transaction ledger with idempotency support';
COMMENT ON COLUMN transactions.transaction_id IS 'Unique external transaction identifier acting as primary key';
COMMENT ON COLUMN transactions.status IS 'Current transaction lifecycle status: PROCESSING or PROCESSED';
COMMENT ON COLUMN transactions.is_scheduled IS 'Internal flag indicating whether the background Cloud Task was successfully enqueued';
COMMENT ON COLUMN transactions.scheduled_at IS 'Timestamp when the Cloud Task was scheduled';
