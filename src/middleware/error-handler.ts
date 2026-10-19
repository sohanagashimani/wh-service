import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../services/transaction.service.js';
import { logger } from '../lib/logger.js';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const formattedErrors = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    logger.warn('Validation error on request', {
      path: req.path,
      method: req.method,
      errors: formattedErrors,
    });

    res.status(400).json({
      error: 'Validation Error',
      details: formattedErrors,
    });
    return;
  }

  // Handle application specific errors
  if (err instanceof AppError) {
    logger.warn(`Application error [${err.statusCode}]`, {
      path: req.path,
      method: req.method,
      statusCode: err.statusCode,
      message: err.message,
    });

    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  // Handle unexpected internal server errors
  logger.error('Unhandled internal server error', {
    path: req.path,
    method: req.method,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  // Never leak internal stack traces or database connection details to clients
  res.status(500).json({
    error: 'Internal Server Error',
  });
}
