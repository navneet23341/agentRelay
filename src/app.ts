import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { query } from './config/database.js';

export const createApp = (): Express => {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const dbCheck = await query('SELECT 1 as healthy');
      const vectorCheck = await query(
        "SELECT installed_version FROM pg_available_extensions WHERE name = 'vector'"
      );

      const isVectorInstalled =
        vectorCheck.rows.length > 0 && !!vectorCheck.rows[0].installed_version;

      res.status(200).json({
        status: 'ok',
        postgres: dbCheck.rows[0]?.healthy === 1 ? 'connected' : 'unhealthy',
        pgvector: {
          installed: isVectorInstalled,
          version: vectorCheck.rows[0]?.installed_version || null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: 'Failed to connect to database',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
};

export default createApp;
