# Transaction Webhook & Background Processing Service

A reliable, idempotent backend service designed to intake external transaction webhooks, persist records in Supabase PostgreSQL, schedule delayed asynchronous processing (~30 seconds in the future) via Google Cloud Tasks, and execute the background processing within a single unified Google Cloud Run service.

---

## 1. Overview & Architecture

### What the Application Does
This service acts as an intake and settlement orchestrator for payment transaction webhooks from external payment providers:
1. Receives and validates incoming transaction webhooks via HTTP POST.
2. Atomically persists transactions in Supabase PostgreSQL with primary key uniqueness guarantees.
3. Schedules a background task in Google Cloud Tasks targeting the internal processing endpoint with a 30-second delay.
4. Responds to the webhook caller immediately with `202 Accepted` (< 500 ms target response time) without blocking on background execution.
5. Handles delayed invocation from Google Cloud Tasks, validates OIDC / queue authentication, executes simulated external settlement, and idempotently transitions transaction state from `PROCESSING` to `PROCESSED`.
6. Provides a status endpoint for clients to query transaction progress.

```
                           +----------------------------------------------------+
                           |             Google Cloud Run Service               |
                           |                                                    |
[Payment Provider] ------->| [1] POST /v1/webhooks/transactions                |
       |                   |       |                                            |
       | (HTTP 202 <500ms) |       +--> [2] Persist in Supabase (status=PROCESSING)|
       |<------------------|       |                                            |
                           |       +--> [3] Schedule Cloud Task (+30s delay)    |
                           +------------------------|---------------------------+
                                                    |
                                                    v
                                      +---------------------------+
                                      |    Google Cloud Tasks     |
                                      | (Durable Queue + Retries) |
                                      +---------------------------+
                                                    | (Delivers after ~30s with OIDC token)
                                                    v
                           +----------------------------------------------------+
                           |             Google Cloud Run Service               |
                           |                                                    |
                           | [4] POST /internal/process-transaction             |
                           |       |                                            |
                           |       +--> Verify OIDC Token & Cloud Tasks Queue   |
                           |       +--> Simulate External API settlement        |
                           |       +--> Atomic DB update: status = PROCESSED    |
                           +----------------------------------------------------+
                                                    ^
                                                    |
[Client / Poller] --------> GET /v1/transactions/:id|
```

### Technology Selection Rationale
- **TypeScript + Node.js + Express**: Provides a lightweight, high-throughput asynchronous runtime with strict compile-time type safety and fast cold starts suitable for serverless container execution.
- **Supabase PostgreSQL**: Offers enterprise-grade relational ACID compliance, native row-level constraints, and atomic conditional updates required for financial state machines.
- **Google Cloud Tasks**: Eliminates the overhead, maintenance, and cost of continuous polling queues (e.g. BullMQ, Redis, Celery). It provides serverless delayed execution, at-least-once delivery guarantees, configurable exponential backoff retries, and OIDC service account authentication.
- **Google Cloud Run**: A fully managed container execution environment that automatically scales down to zero when idle, minimizing costs while scaling rapidly during webhook traffic spikes. Both public intake endpoints and the internal worker endpoint live in a single application.

---

## 2. Transaction Lifecycle & Idempotency Strategy

### Transaction Lifecycle
A transaction moves through two externally visible states:
- `PROCESSING`: Initial state after webhook acceptance and database persistence.
- `PROCESSED`: Terminal state reached after simulated settlement has completed and timestamp `processed_at` is recorded.

```
           +--------------------+
           |  Webhook Received  |
           +--------------------+
                     |
                     v
             [Insert into DB]
                     |
                     v
           +--------------------+
           |     PROCESSING     |<----+ (Duplicate webhook or retry)
           +--------------------+     |
                     |                |
             [30s Delay Task]         |
                     |                |
                     v                |
           [Internal Task Runs]-------+
                     |
                     v (Atomic Update)
           +--------------------+
           |     PROCESSED      |
           +--------------------+
```

### Idempotency & Concurrency Guarantees

#### 1. Duplicate Webhooks
- **Database Uniqueness**: `transaction_id` is defined as `PRIMARY KEY` in PostgreSQL. Any duplicate insertion attempt immediately raises error code `23505` (`unique_violation`).
- **Graceful Response**: When a duplicate insert error occurs, the service queries the existing record:
  - If the transaction is already `PROCESSED`: Returns `202 Accepted` immediately without enqueuing another task.
  - If the transaction is `PROCESSING` and `is_scheduled = true`: Returns `202 Accepted` without creating duplicate tasks.
  - If the transaction is `PROCESSING` and `is_scheduled = false`: Recognizes a previous task creation failure and attempts recovery by scheduling the task.
- **Concurrent Webhook Bursts**: When multiple concurrent requests arrive with the same `transaction_id`:
  - Exactly one request succeeds in inserting the database row.
  - Cloud Tasks deterministic task naming (`tasks/txn-<transaction_id>`) guarantees that even if two concurrent requests attempt to enqueue a task, Cloud Tasks deduplicates by task name (returning `ALREADY_EXISTS`), preventing duplicate job execution.

#### 2. Duplicate Task Delivery
Cloud Tasks guarantees **at-least-once** delivery. Network partitions or worker timeouts can result in the same task being delivered more than once.
- **Pre-check**: When `/internal/process-transaction` executes, it first inspects the transaction status. If `status === 'PROCESSED'`, it returns `200 OK` immediately without repeating the simulated settlement.
- **Atomic State Transition**: The status update is executed with an atomic SQL conditional query:
  ```sql
  UPDATE transactions
  SET status = 'PROCESSED', processed_at = NOW()
  WHERE transaction_id = $1 AND status = 'PROCESSING';
  ```
  If another concurrent delivery already completed the update, rows affected is `0`, preventing race conditions and double settlement.

#### 3. Task Creation Failures & Recovery
Creating a database record and scheduling a Cloud Task are separate non-atomic network operations:
- When a transaction is persisted in PostgreSQL, it is initially flagged with `is_scheduled = false`.
- If Cloud Tasks scheduling fails (e.g., transient network partition or quota issue):
  - The API does **not** return a misleading `202 Accepted`. Instead, it returns `503 Service Unavailable`.
  - The record remains safely stored in PostgreSQL with `is_scheduled = false`.
  - When the payment processor retries the webhook, the service identifies the existing unscheduled transaction and retries the Cloud Tasks creation step.
  - Once scheduled, `is_scheduled` is set to `true`.

#### 4. Retry Behavior
- **Transient Failures (DB connection loss, 5xx errors)**: The handler returns `500 Internal Server Error`, instructing Cloud Tasks to retry with exponential backoff according to the queue configuration.
- **Permanent Validation Failures (Missing transaction)**: Returns `404 Not Found`, signaling that retrying is futile.

---

## 3. Endpoints Specification

### 1. Health Check
- **Method**: `GET /`
- **Response**: `200 OK`
```json
{
  "status": "HEALTHY",
  "current_time": "2026-10-19T10:30:00.000Z"
}
```

### 2. Transaction Webhook Intake
- **Method**: `POST /v1/webhooks/transactions`
- **Request Body**:
```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR"
}
```
- **Response**: `202 Accepted`
```json
{
  "status": "ACCEPTED",
  "message": "Transaction accepted and scheduled for processing",
  "transaction_id": "txn_abc123def456"
}
```

### 3. Transaction Status
- **Method**: `GET /v1/transactions/:transaction_id`
- **Response (While Pending)**: `200 OK`
```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR",
  "status": "PROCESSING",
  "created_at": "2026-10-19T10:30:00.000Z",
  "processed_at": null
}
```
- **Response (After ~30s Processing)**: `200 OK`
```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR",
  "status": "PROCESSED",
  "created_at": "2026-10-19T10:30:00.000Z",
  "processed_at": "2026-10-19T10:30:30.123Z"
}
```
- **Response (Missing Transaction)**: `404 Not Found`
```json
{
  "error": "Transaction not found: txn_missing"
}
```

### 4. Internal Task Processing Endpoint
- **Method**: `POST /internal/process-transaction`
- **Authentication**: Google Cloud Tasks OIDC Bearer Token or `X-Internal-Token` header.
- **Request Body**:
```json
{
  "transaction_id": "txn_abc123def456"
}
```
- **Response**: `200 OK`
```json
{
  "status": "PROCESSED",
  "transaction_id": "txn_abc123def456",
  "processed_at": "2026-10-19T10:30:30.123Z"
}
```

---

## 4. Local Development & Testing

### Prerequisites
- Node.js >= 18 (Node 22 LTS recommended)
- npm >= 9

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
For local testing, defaults are pre-configured in `.env`.

### Step 3: Run Automated Tests
Execute the comprehensive Vitest suite (14 tests covering all 12 assessment criteria):
```bash
npm test
```

### Step 4: Run Type Checking & Build
```bash
npm run typecheck
npm run build
```

### Step 5: Start Development Server
```bash
npm run dev
```

The server will start on `http://localhost:8080`.

---

## 5. Testing with cURL

### 1. Health Check
```bash
curl -X GET http://localhost:8080/
```

### 2. Send Transaction Webhook
```bash
curl -X POST http://localhost:8080/v1/webhooks/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "txn_demo_101",
    "source_account": "acc_user_101",
    "destination_account": "acc_merchant_202",
    "amount": 2499.50,
    "currency": "INR"
  }'
```

### 3. Check Status Immediately (Returns `PROCESSING`)
```bash
curl -X GET http://localhost:8080/v1/transactions/txn_demo_101
```

### 4. Direct Invocation of Task Handler (Dev Testing)
```bash
curl -X POST http://localhost:8080/internal/process-transaction \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: local-dev-secret-token" \
  -H "x-cloudtasks-queuename: transaction-tasks" \
  -d '{
    "transaction_id": "txn_demo_101"
  }'
```

### 5. Check Status After Processing (Returns `PROCESSED`)
```bash
curl -X GET http://localhost:8080/v1/transactions/txn_demo_101
```

---

## 6. Cloud Configuration & Deployment

### A. Supabase PostgreSQL Setup
1. Create a project at [supabase.com](https://supabase.com).
2. Go to the **SQL Editor** in your Supabase dashboard.
3. Paste and run the migration script located at `supabase/migrations/001_create_transactions.sql`:
   ```sql
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

   CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
   ```
4. Retrieve your **Project URL** and **Service Role Key** (under Project Settings -> API).

### B. Google Cloud Configuration
Set your GCP project:
```bash
gcloud config set project YOUR_GCP_PROJECT_ID
export PROJECT_ID="YOUR_GCP_PROJECT_ID"
export REGION="asia-south1"  # or us-central1 / your preferred region
export QUEUE_NAME="transaction-tasks"
export SERVICE_ACCOUNT="cloud-tasks-invoker@${PROJECT_ID}.iam.gserviceaccount.com"
```

#### 1. Enable Required GCP APIs
```bash
gcloud services enable run.googleapis.com cloudtasks.googleapis.com iam.googleapis.com
```

#### 2. Create the Cloud Tasks Queue
```bash
gcloud tasks queues create $QUEUE_NAME \
  --location=$REGION \
  --max-dispatches-per-second=50 \
  --max-concurrent-dispatches=100 \
  --max-attempts=5 \
  --min-backoff=5s \
  --max-backoff=60s
```

#### 3. Create Dedicated Invoker Service Account
```bash
gcloud iam service-accounts create cloud-tasks-invoker \
  --description="Dedicated invoker service account for Cloud Tasks" \
  --display-name="Cloud Tasks Invoker"
```

### C. Deploy Service to Google Cloud Run
Deploy using Google Cloud Build directly from source (no local Docker required):
```bash
gcloud run deploy wh-service \
  --source . \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=10 \
  --set-env-vars="\
NODE_ENV=production,\
SUPABASE_URL=https://your-project-ref.supabase.co,\
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key,\
GCP_PROJECT_ID=${PROJECT_ID},\
CLOUD_TASKS_QUEUE=${QUEUE_NAME},\
CLOUD_TASKS_LOCATION=${REGION},\
CLOUD_RUN_SERVICE_URL=https://wh-service-REPLACE_ME.a.run.app,\
CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL=${SERVICE_ACCOUNT}"
```

#### 4. Grant Cloud Run Invoker Role to Service Account
```bash
gcloud run services add-iam-policy-binding wh-service \
  --region=$REGION \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/run.invoker"
```

#### 5. Update Cloud Run with its Public URL
Once deployed, retrieve the service URL and update the `CLOUD_RUN_SERVICE_URL` environment variable:
```bash
SERVICE_URL=$(gcloud run services describe wh-service --region=$REGION --format="value(status.url)")

gcloud run services update wh-service \
  --region=$REGION \
  --update-env-vars="CLOUD_RUN_SERVICE_URL=${SERVICE_URL}"
```

---

## 7. How to Verify 30-Second Delayed Processing

1. Send a transaction webhook to your deployed Cloud Run URL:
   ```bash
   curl -i -X POST "${SERVICE_URL}/v1/webhooks/transactions" \
     -H "Content-Type: application/json" \
     -d '{
       "transaction_id": "txn_timing_test_001",
       "source_account": "acc_buyer_1",
       "destination_account": "acc_seller_2",
       "amount": 500,
       "currency": "INR"
     }'
   ```
   *Note: HTTP 202 is returned in < 200 ms.*

2. Query status immediately (at T+2s):
   ```bash
   curl "${SERVICE_URL}/v1/transactions/txn_timing_test_001"
   ```
   *Output shows `status: "PROCESSING"` and `processed_at: null`.*

3. Query status again after 35 seconds (at T+35s):
   ```bash
   curl "${SERVICE_URL}/v1/transactions/txn_timing_test_001"
   ```
   *Output shows `status: "PROCESSED"` and `processed_at` with timestamp exactly ~30 seconds after `created_at`.*

4. View structured logs in Cloud Logging:
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.transaction_id="txn_timing_test_001"' \
     --limit 10 \
     --format "table(timestamp, jsonPayload.severity, jsonPayload.message)"
   ```

---

## 8. Implementation Limitations & Trade-offs

1. **Dual-Write Vulnerability Window**:
   Persisting to PostgreSQL and enqueueing into Cloud Tasks cannot be executed in a single atomic two-phase commit without introducing an Outbox pattern or Change Data Capture (CDC via Debezium/Listen-Notify).
   *Mitigation*: If task scheduling fails after DB insertion, we do not return 202; instead we return 503 and leave `is_scheduled = false`, allowing subsequent webhook retries to recover the scheduling attempt.
2. **At-Least-Once Delivery**:
   Cloud Tasks guarantees at-least-once delivery, not exactly-once delivery.
   *Mitigation*: The internal handler enforces idempotency using atomic SQL conditional updates (`UPDATE ... WHERE transaction_id = $1 AND status = 'PROCESSING'`), ensuring processing runs exactly once.
3. **Simulated External Settlement**:
   Per assessment instructions, the external settlement is simulated via a lightweight asynchronous placeholder rather than invoking a live payment gateway.
