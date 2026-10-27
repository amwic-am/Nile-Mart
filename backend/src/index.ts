import app from './app.js';
import { config } from './config.js';
import { closeDatabase, getDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './lib/logger.js';
import { expireStaleReservations } from './services/orders.js';

const db = await getDatabase();
await runMigrations(db);

const reservationSweep = setInterval(
  () => {
    expireStaleReservations(db).catch((error) =>
      logger.warn('Reservation sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  },
  5 * 60 * 1000,
);
reservationSweep.unref();
expireStaleReservations(db).catch((error) =>
  logger.warn('Initial reservation sweep failed', {
    error: error instanceof Error ? error.message : String(error),
  }),
);

const server = app.listen(config.port, () => {
  logger.info(`Nile Mart API listening on http://localhost:${config.port}`, {
    env: config.env,
    database: config.databaseUrl ? 'postgres' : 'pglite',
  });
  if (!config.databaseUrl) {
    logger.info('Embedded database ready. Storefront: http://localhost:5173 (npm run dev)');
  }
});

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down`);
  clearInterval(reservationSweep);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
