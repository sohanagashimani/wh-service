import { TransactionRecord } from '../../src/types/transaction.js';

export class MockSupabase {
  public store = new Map<string, TransactionRecord>();
  public shouldFailInsert = false;
  public shouldFailSelect = false;
  public shouldFailUpdate = false;
  public transientErrorMessage = 'Simulated Supabase transient error';

  reset(): void {
    this.store.clear();
    this.shouldFailInsert = false;
    this.shouldFailSelect = false;
    this.shouldFailUpdate = false;
  }

  from(table: string) {
    if (table !== 'transactions') {
      throw new Error(`Unsupported mock table: ${table}`);
    }

    const self = this;

    return {
      insert(record: Partial<TransactionRecord>) {
        return {
          select() {
            return {
              single: async () => {
                if (self.shouldFailInsert) {
                  return { data: null, error: { message: self.transientErrorMessage, code: '50000' } };
                }

                const id = record.transaction_id!;
                if (self.store.has(id)) {
                  return {
                    data: null,
                    error: {
                      message: 'duplicate key value violates unique constraint',
                      code: '23505',
                    },
                  };
                }

                const newRecord: TransactionRecord = {
                  transaction_id: id,
                  source_account: record.source_account!,
                  destination_account: record.destination_account!,
                  amount: Number(record.amount!),
                  currency: record.currency!,
                  status: record.status || 'PROCESSING',
                  is_scheduled: record.is_scheduled || false,
                  scheduled_at: record.scheduled_at || null,
                  created_at: record.created_at || new Date().toISOString(),
                  processed_at: record.processed_at || null,
                };

                self.store.set(id, newRecord);
                return { data: { ...newRecord }, error: null };
              },
            };
          },
        };
      },

      select(fields = '*') {
        return {
          eq(column: string, value: string) {
            return {
              single: async () => {
                if (self.shouldFailSelect) {
                  return { data: null, error: { message: self.transientErrorMessage, code: '50000' } };
                }
                if (column === 'transaction_id') {
                  const record = self.store.get(value);
                  if (!record) {
                    return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
                  }
                  return { data: { ...record }, error: null };
                }
                return { data: null, error: { message: 'Column not supported in mock', code: '50000' } };
              },
              maybeSingle: async () => {
                if (self.shouldFailSelect) {
                  return { data: null, error: { message: self.transientErrorMessage, code: '50000' } };
                }
                if (column === 'transaction_id') {
                  const record = self.store.get(value);
                  return { data: record ? { ...record } : null, error: null };
                }
                return { data: null, error: { message: 'Column not supported in mock', code: '50000' } };
              },
            };
          },
        };
      },

      update(updates: Partial<TransactionRecord>) {
        return {
          eq(column1: string, val1: string) {
            return {
              // Simple update by transaction_id
              then(resolve: (value: { error: unknown }) => void) {
                if (self.shouldFailUpdate) {
                  return resolve({ error: { message: self.transientErrorMessage } });
                }
                if (column1 === 'transaction_id') {
                  const existing = self.store.get(val1);
                  if (existing) {
                    Object.assign(existing, updates);
                    self.store.set(val1, existing);
                  }
                }
                return resolve({ error: null });
              },
              // Conditional update: .eq('transaction_id', id).eq('status', 'PROCESSING')
              eq(column2: string, val2: string) {
                return {
                  select() {
                    return {
                      maybeSingle: async () => {
                        if (self.shouldFailUpdate) {
                          return { data: null, error: { message: self.transientErrorMessage } };
                        }

                        if (column1 === 'transaction_id' && column2 === 'status') {
                          const existing = self.store.get(val1);
                          if (!existing || existing.status !== val2) {
                            return { data: null, error: null };
                          }

                          Object.assign(existing, updates);
                          self.store.set(val1, existing);
                          return { data: { ...existing }, error: null };
                        }

                        return { data: null, error: { message: 'Unsupported update condition' } };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  }
}

export const mockSupabase = new MockSupabase();
