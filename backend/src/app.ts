import express, { Request, Response } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { prisma } from './lib/prisma.js';

export const app = express();

// Enable CORS restricted to the frontend origin
app.use(
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
  })
);

// Body parsing
app.use(express.json());

// Health Check Endpoint (reporting service & database connectivity)
app.get('/api/health', async (_req: Request, res: Response) => {
  let dbStatus = 'disconnected';
  let dbError: string | undefined;

  try {
    // Lightweight database query with 2s timeout
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database query timed out')), 2000)
      ),
    ]);
    dbStatus = 'connected';
  } catch (err: unknown) {
    dbStatus = 'disconnected';
    dbError = err instanceof Error ? err.message : 'Database connection unavailable';
  }

  const isHealthy = dbStatus === 'connected';

  res.status(200).json({
    status: isHealthy ? 'OK' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    database: {
      status: dbStatus,
      ...(dbError ? { error: dbError } : {}),
    },
  });
});

// Centralized error handler
app.use(errorHandler);
