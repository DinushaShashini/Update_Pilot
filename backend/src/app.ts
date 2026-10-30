import express, { Request, Response } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';

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

// Health Check Endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

// Centralized error handler
app.use(errorHandler);
