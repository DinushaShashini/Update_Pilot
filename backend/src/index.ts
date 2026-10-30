import { app } from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.PORT, () => {
  console.log(`🚀 UpdatePilot backend listening on http://localhost:${env.PORT}`);
  console.log(`🌐 Allowed CORS origin: ${env.FRONTEND_ORIGIN}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
