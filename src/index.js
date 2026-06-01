import { startServer } from './server.js';
import { logger } from './utils/logger.js';
import { getStatus, ACCOUNTS_FILE } from './account-manager.js';

const PORT = Number(process.env.PORT || 8081);

let server;
let shuttingDown = false;

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;

  shuttingDown = true;
  logger.warn(`[Process] ${reason} received, shutting down RemoteCodex...`);

  if (!server) {
    process.exit(exitCode);
    return;
  }

  const forceExitTimer = setTimeout(() => {
    logger.error('[Process] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);

  forceExitTimer.unref?.();

  server.close((error) => {
    clearTimeout(forceExitTimer);
    if (error) {
      logger.error('[Process] Failed to close server cleanly.', error);
      process.exit(1);
      return;
    }
    logger.info('[Process] RemoteCodex stopped.');
    process.exit(exitCode);
  });
}

try {
  server = startServer({ port: PORT });
} catch (error) {
  logger.error('[Process] Failed to start RemoteCodex.', error);
  process.exit(1);
}

server.on('error', (error) => {
  logger.error('[Process] HTTP server error.', error);
  process.exit(1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('[Process] Unhandled promise rejection.', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  logger.error('[Process] Uncaught exception.', error);
  shutdown('uncaughtException', 1);
});

console.log(`
RemoteCodex v1.0.0
Dashboard: http://localhost:${PORT}
Health:    http://localhost:${PORT}/health
Runtime:   Codex CLI
Channel:   Telegram
`);

const status = getStatus();
logger.info(`Accounts: ${status.total} total, Active: ${status.active || 'None'}`);
if (status.total === 0) {
  logger.warn(`No accounts configured. Open http://localhost:${PORT} to add one.`);
}
logger.info(`Accounts config: ${ACCOUNTS_FILE}`);
