import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

let authClient: OAuth2Client | null = null;

function getAuthClient(): OAuth2Client {
  if (!authClient) {
    authClient = new OAuth2Client();
  }
  return authClient;
}

export function setAuthClient(client: OAuth2Client | null): void {
  authClient = client;
}

/**
 * Middleware to authenticate requests to the internal task handler endpoint.
 * Supports:
 * 1. Google Cloud Tasks OIDC token validation via Google public certs.
 * 2. Shared internal secret (INTERNAL_AUTH_TOKEN) for local development and direct testing.
 * 3. Validation of Cloud Tasks queue header (x-cloudtasks-queuename).
 */
export async function verifyTaskAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const queueHeader = req.headers['x-cloudtasks-queuename'] as string | undefined;
  const authHeader = req.headers['authorization'];
  const internalTokenHeader = req.headers['x-internal-token'] as string | undefined;

  // Verify Cloud Tasks Queue Header if present
  if (queueHeader && queueHeader !== env.CLOUD_TASKS_QUEUE) {
    logger.warn('Unauthorized task invocation: queue name mismatch', {
      received_queue: queueHeader,
      expected_queue: env.CLOUD_TASKS_QUEUE,
    });
    res.status(403).json({ error: 'Forbidden: Invalid Cloud Tasks queue' });
    return;
  }

  // Check 1: Shared internal auth token (for dev/test environments)
  if (env.INTERNAL_AUTH_TOKEN) {
    if (internalTokenHeader && internalTokenHeader === env.INTERNAL_AUTH_TOKEN) {
      return next();
    }
    if (authHeader && authHeader === `Bearer ${env.INTERNAL_AUTH_TOKEN}`) {
      return next();
    }
  }

  // In test mode, if testing without live GCP, allow bypassing if explicitly configured
  if (env.NODE_ENV === 'test' && (!authHeader || authHeader === 'Bearer mock-test-token')) {
    return next();
  }

  // Check 2: Google Cloud Tasks OIDC Bearer Token verification
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.substring(7);

    try {
      const client = getAuthClient();
      const ticket = await client.verifyIdToken({
        idToken,
        audience: env.CLOUD_RUN_SERVICE_URL,
      });

      const payload = ticket.getPayload();

      // If a specific service account is configured, verify the token's email
      if (
        env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL &&
        payload?.email !== env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL
      ) {
        logger.warn('Unauthorized task invocation: service account email mismatch', {
          token_email: payload?.email,
          expected_email: env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL,
        });
        res.status(403).json({ error: 'Forbidden: Service account not authorized' });
        return;
      }

      logger.debug('Authenticated task invocation via Google OIDC', {
        email: payload?.email,
      });
      return next();
    } catch (err: unknown) {
      logger.warn('OIDC token verification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(401).json({ error: 'Unauthorized: Invalid OIDC token' });
      return;
    }
  }

  logger.warn('Missing authentication credentials on internal task endpoint', {
    ip: req.ip,
    headers: Object.keys(req.headers),
  });
  res.status(401).json({ error: 'Unauthorized: Authentication required' });
}
