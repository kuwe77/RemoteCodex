import express from 'express';
import cors from 'cors';

import { ensureAccountsPersist, startAutoRefresh } from './account-manager.js';
import { registerApiRoutes } from './routes/api-routes.js';
import { setRequestLoggingEnabled } from './request-logger.js';
import { getServerSettings } from './server-settings.js';
import agentChannelManager from './agent-channels/manager.js';
import codexDesktopBridgeObserver from './codex-desktop-bridge-observer.js';

export function createServer({ port }) {
  ensureAccountsPersist();
  startAutoRefresh();

  const settings = getServerSettings();
  setRequestLoggingEnabled(settings.enableRequestLogging !== false);

  const app = express();
  app.locals.port = port;
  app.locals.agentChannelManager = agentChannelManager;
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const msg = `[${req.method}] ${req.originalUrl} ${res.statusCode} (${duration}ms)`;
      if (res.statusCode >= 400) {
        console.log(`\x1b[31m${msg}\x1b[0m`);
      } else if (req.originalUrl !== '/health') {
        console.log(`\x1b[36m${msg}\x1b[0m`);
      }
    });
    next();
  });

  app.use(cors({
    origin: [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost',
      'http://127.0.0.1'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Content-Encoding', 'ChatGPT-Account-ID', 'OpenAI-Organization'],
    credentials: false
  }));

  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      if (buf?.length) {
        req.rawBody = Buffer.from(buf);
      }
    }
  }));

  registerApiRoutes(app, { port });

  agentChannelManager.start().catch((error) => {
    console.error('[AgentChannel] Failed to start channel manager:', error.message);
  });
  codexDesktopBridgeObserver.start();

  app.use((err, req, res, _next) => {
    console.error(`[Server] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ type: 'error', error: { type: 'server_error', message: err.message } });
    }
  });

  return app;
}

export function startServer({ port }) {
  const app = createServer({ port });
  const server = app.listen(port);
  server.on('close', () => {
    agentChannelManager.stop().catch(() => {});
    codexDesktopBridgeObserver.stop();
  });
  return server;
}

export default { createServer, startServer };
