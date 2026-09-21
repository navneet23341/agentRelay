import dotenv from 'dotenv';
import { createApp } from './app.js';
import { pool } from './config/database.js';

dotenv.config();

const app = createApp();
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`[agentRelay] Server running on http://localhost:${PORT}`);
});

const gracefulShutdown = async (signal: string) => {
  console.log(`\n[agentRelay] Received ${signal}. Gracefully shutting down...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('[agentRelay] PostgreSQL pool closed cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('[agentRelay] Error closing PostgreSQL pool:', err);
      process.exit(1);
    }
  });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export default server;
