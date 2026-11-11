import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: unknown[];
}

export const errorHandler = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const isPayloadTooLarge = (err as unknown as { type?: string }).type === 'entity.too.large' || err.statusCode === 413;
  const statusCode = isPayloadTooLarge ? 413 : (err.statusCode || 500);
  const code = isPayloadTooLarge ? 'PAYLOAD_TOO_LARGE' : (err.code || (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST'));
  const message = isPayloadTooLarge ? 'Payload too large' : (err.message || 'An unexpected error occurred.');

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details: err.details || [],
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    },
  });
};
