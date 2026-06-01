import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';
import { setTimeout as delay } from 'timers/promises';

import { CONFIG_DIR } from './account-manager.js';
import { buildCliNotFoundError, buildSpawnCommand } from './agent-runtime/cli-resolver.js';
import { logger } from './utils/logger.js';

const DEFAULT_LISTEN_URL = String(process.env.REMOTECODEX_CODEX_APP_SERVER_LISTEN || 'ws://127.0.0.1:8765').trim();
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_POLL_MS = 250;

function nowIso() {
  return new Date().toISOString();
}

function buildHealthUrl(listenUrl) {
  const url = new URL(listenUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/healthz';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function sanitizeThreadName(value, maxLength = 96) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return 'RemoteCodex session';
  return compact.slice(0, maxLength);
}

export function isCodexDesktopBridgeableSession(session = null) {
  return session?.provider === 'codex' && Boolean(String(session?.providerSessionId || '').trim());
}

export function buildCodexDesktopBridgeName(session = null) {
  const channel = String(session?.metadata?.source?.channel || '').trim();
  const prefix = channel ? `${channel.charAt(0).toUpperCase()}${channel.slice(1)}:` : 'RemoteCodex:';
  return sanitizeThreadName(`${prefix} ${session?.title || 'Untitled task'}`);
}

export function buildCodexDesktopBridgeMetadata(session = null, bridge = {}, extra = {}) {
  const current = session?.metadata?.codexDesktopBridge || {};
  return {
    ...current,
    sessionId: String(session?.id || current.sessionId || ''),
    threadId: String(bridge?.threadId || current.threadId || ''),
    sourceThreadId: String(bridge?.sourceThreadId || session?.providerSessionId || current.sourceThreadId || ''),
    path: String(bridge?.path || current.path || ''),
    cwd: String(bridge?.cwd || session?.cwd || current.cwd || ''),
    name: String(bridge?.name || current.name || ''),
    source: String(bridge?.source || current.source || ''),
    archivedThreadId: String(bridge?.archivedThreadId || current.archivedThreadId || ''),
    createdAt: String(bridge?.createdAt || current.createdAt || nowIso()),
    updatedAt: nowIso(),
    openedApp: Boolean(bridge?.openedApp),
    lastError: '',
    failedAt: '',
    ...extra
  };
}

export function buildCodexDesktopBridgeSessionPatch(session = null, bridge = {}, extra = {}) {
  return {
    providerSessionId: String(bridge?.threadId || session?.providerSessionId || ''),
    metadata: {
      codexDesktopBridge: buildCodexDesktopBridgeMetadata(session, bridge, extra)
    }
  };
}

function createJsonRpcWebSocketClient(listenUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket support is unavailable in this Node runtime');
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(listenUrl);
    let settled = false;
    let nextId = 1;
    const pending = new Map();

    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    };

    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      rejectPending(error);
    };

    ws.addEventListener('open', async () => {
      const client = {
        async call(method, params) {
          return new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id,
              method,
              params
            }));
          });
        },
        async close() {
          try {
            ws.close();
          } catch {
            // Ignore close failures on teardown.
          }
        }
      };

      try {
        await client.call('initialize', {
          clientInfo: {
            name: 'remotecodex-codex-bridge',
            title: 'RemoteCodex Codex Desktop Bridge',
            version: '1.0.0'
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: []
          }
        });
        if (!settled) {
          settled = true;
          resolve(client);
        }
      } catch (error) {
        fail(error);
      }
    });

    ws.addEventListener('message', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(String(event.data || ''));
      } catch {
        return;
      }

      if (!payload || payload.id === undefined || payload.id === null) {
        return;
      }

      const pendingCall = pending.get(payload.id);
      if (!pendingCall) {
        return;
      }

      pending.delete(payload.id);

      if (payload.error) {
        pendingCall.reject(new Error(`${pendingCall.method} failed: ${JSON.stringify(payload.error)}`));
        return;
      }

      pendingCall.resolve(payload.result);
    });

    ws.addEventListener('error', (event) => {
      const error = event?.error instanceof Error
        ? event.error
        : new Error(event?.message || `Unable to connect to Codex app-server at ${listenUrl}`);
      fail(error);
    });

    ws.addEventListener('close', () => {
      const error = new Error(`Codex app-server connection closed: ${listenUrl}`);
      if (!settled) {
        settled = true;
        reject(error);
      }
      rejectPending(error);
    });
  });
}

export class CodexDesktopBridgeService {
  constructor({
    listenUrl = DEFAULT_LISTEN_URL,
    configDir = CONFIG_DIR,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    spawnImpl = spawn,
    appLogger = logger,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    healthPollMs = DEFAULT_HEALTH_POLL_MS
  } = {}) {
    this.listenUrl = listenUrl;
    this.healthUrl = buildHealthUrl(listenUrl);
    this.configDir = configDir;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.logger = appLogger;
    this.startupTimeoutMs = startupTimeoutMs;
    this.healthPollMs = healthPollMs;
    this.startPromise = null;
  }

  getLogPaths() {
    const logsDir = join(this.configDir, 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    return {
      stdout: join(logsDir, 'codex-app-server.stdout.log'),
      stderr: join(logsDir, 'codex-app-server.stderr.log')
    };
  }

  async checkHealth() {
    if (typeof this.fetchImpl !== 'function') {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await this.fetchImpl(this.healthUrl, {
        method: 'GET',
        signal: controller.signal
      });
      return Boolean(response?.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async ensureAppServerRunning() {
    if (await this.checkHealth()) {
      return true;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startAppServer();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startAppServer() {
    const { command, args } = buildSpawnCommand('codex', [
      'app-server',
      '--listen',
      this.listenUrl
    ]);

    const logPaths = this.getLogPaths();
    let stdoutFd = null;
    let stderrFd = null;

    try {
      stdoutFd = openSync(logPaths.stdout, 'a', 0o600);
      stderrFd = openSync(logPaths.stderr, 'a', 0o600);
    } catch {
      stdoutFd = null;
      stderrFd = null;
    }

    try {
      this.logger.info(`[CodexDesktopBridge] Starting Codex app-server on ${this.listenUrl}`);

      const child = this.spawnImpl(command, args, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd ?? 'ignore', stderrFd ?? 'ignore']
      });

      let spawnError = null;
      child.once('error', (error) => {
        spawnError = error;
      });
      child.unref?.();

      const deadline = Date.now() + this.startupTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) {
          throw spawnError;
        }
        if (await this.checkHealth()) {
          return true;
        }
        await delay(this.healthPollMs);
      }

      if (spawnError) {
        throw spawnError;
      }

      throw new Error(`Timed out waiting for Codex app-server at ${this.healthUrl}`);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw buildCliNotFoundError('codex', error);
      }
      throw error;
    } finally {
      if (typeof stdoutFd === 'number') {
        closeSync(stdoutFd);
      }
      if (typeof stderrFd === 'number') {
        closeSync(stderrFd);
      }
    }
  }

  async withClient(callback) {
    await this.ensureAppServerRunning();
    const client = await createJsonRpcWebSocketClient(this.listenUrl);
    try {
      return await callback(client);
    } finally {
      await client.close();
    }
  }

  async openDesktopApp(workspacePath) {
    const cwd = String(workspacePath || '').trim();
    if (!cwd) {
      return false;
    }

    const { command, args } = buildSpawnCommand('codex', ['app', cwd]);

    return new Promise((resolve, reject) => {
      try {
        const child = this.spawnImpl(command, args, {
          detached: true,
          windowsHide: true,
          stdio: 'ignore'
        });

        child.once('error', (error) => {
          if (error?.code === 'ENOENT') {
            reject(buildCliNotFoundError('codex', error));
            return;
          }
          reject(error);
        });

        child.once('spawn', () => {
          child.unref?.();
          resolve(true);
        });
      } catch (error) {
        if (error?.code === 'ENOENT') {
          reject(buildCliNotFoundError('codex', error));
          return;
        }
        reject(error);
      }
    });
  }

  async bridgeRuntimeSession({ session, openApp = false } = {}) {
    if (!isCodexDesktopBridgeableSession(session)) {
      throw new Error('session is not bridgeable to Codex Desktop');
    }

    return this.withClient(async (client) => {
      const currentThreadId = String(session?.providerSessionId || '').trim();
      const previousThreadId = String(session?.metadata?.codexDesktopBridge?.threadId || '').trim();
      const currentBridge = session?.metadata?.codexDesktopBridge || {};
      let archivedThreadId = '';

      if (previousThreadId && previousThreadId === currentThreadId) {
        const bridgeName = buildCodexDesktopBridgeName(session);
        try {
          await client.call('thread/name/set', {
            threadId: previousThreadId,
            name: bridgeName
          });
        } catch (error) {
          this.logger.warn(`[CodexDesktopBridge] Failed to refresh bridged thread name ${previousThreadId}: ${error.message}`);
        }

        const openedApp = openApp ? await this.openDesktopApp(session.cwd) : false;
        return {
          threadId: previousThreadId,
          sourceThreadId: String(currentBridge.sourceThreadId || previousThreadId),
          archivedThreadId: '',
          path: String(currentBridge.path || '').trim(),
          cwd: String(session?.cwd || currentBridge.cwd || '').trim(),
          name: bridgeName,
          source: String(currentBridge.source || 'appServer'),
          createdAt: String(currentBridge.createdAt || nowIso()),
          openedApp
        };
      }

      if (previousThreadId && previousThreadId !== currentThreadId) {
        try {
          await client.call('thread/archive', { threadId: previousThreadId });
          archivedThreadId = previousThreadId;
        } catch (error) {
          this.logger.warn(`[CodexDesktopBridge] Failed to archive previous thread ${previousThreadId}: ${error.message}`);
        }
      }

      const forked = await client.call('thread/fork', {
        threadId: currentThreadId,
        cwd: String(session.cwd || '').trim() || null,
        persistExtendedHistory: true,
        ephemeral: false
      });

      const bridgeThreadId = String(forked?.thread?.id || '').trim();
      if (!bridgeThreadId) {
        throw new Error('Codex app-server returned no thread id while bridging');
      }

      const bridgeName = buildCodexDesktopBridgeName(session);
      try {
        await client.call('thread/name/set', {
          threadId: bridgeThreadId,
          name: bridgeName
        });
      } catch (error) {
        this.logger.warn(`[CodexDesktopBridge] Failed to name bridged thread ${bridgeThreadId}: ${error.message}`);
      }

      const openedApp = openApp ? await this.openDesktopApp(session.cwd) : false;

      return {
        threadId: bridgeThreadId,
        sourceThreadId: String(session.providerSessionId || '').trim(),
        archivedThreadId,
        path: String(forked?.thread?.path || '').trim(),
        cwd: String(forked?.thread?.cwd || session.cwd || '').trim(),
        name: bridgeName,
        source: typeof forked?.thread?.source === 'string'
          ? String(forked.thread.source)
          : String(forked?.thread?.source?.custom || 'appServer'),
        createdAt: nowIso(),
        openedApp
      };
    });
  }
}

export const codexDesktopBridgeService = new CodexDesktopBridgeService();

export default codexDesktopBridgeService;
