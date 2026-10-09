import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { startHoldReaper, stopHoldReaper } from './lib/holdReaper.js';
import { startRetentionSweeper, stopRetentionSweeper } from './lib/retention.js';

// Expired payment holds are swept on a timer rather than on the search path.
// See lib/holdReaper.ts for why a backstop is still kept.
// Expired OTP codes and refresh tokens are swept hourly. See lib/retention.js for why
// the two windows differ.
startHoldReaper();
startRetentionSweeper();

const app = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`\n  HostelMitra API`);
  console.log(`  env              ${config.NODE_ENV}`);
  console.log(`  listening        http://localhost:${config.PORT}`);
  console.log(`  payment gateway  ${config.paymentProvider}${config.paymentProvider === 'mock' ? ' (no real money moves)' : ''}`);
  console.log(`  storage          ${config.storageDriver}`);
  console.log(`  sms              ${config.OTP_PROVIDER}`);
  console.log('');
});

/**
 * Graceful shutdown.
 *
 * Without this, `docker compose down` and every deploy kills in-flight requests
 * mid-payment-capture. Draining connections first is what stops a booking from
 * being captured by the gateway but never written to the database.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);

  // 10s is enough for a payment webhook in flight, short enough that a platform
  // restart does not trip its own health-check timeout.
  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out; forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    try {
      stopHoldReaper();
      stopRetentionSweeper();
      await prisma.$disconnect();
      console.log('Closed cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('Error while closing database connection:', err);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  // The process state is unknown after an uncaught exception, so the only safe
  // move is to log and let the platform restart a clean process.
  console.error('Uncaught exception:', err);
  void shutdown('uncaughtException');
});