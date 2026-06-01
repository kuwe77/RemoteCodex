import agentRuntimeSessionManager from './agent-runtime/session-manager.js';
import { AGENT_EVENT_TYPE } from './agent-runtime/models.js';
import codexDesktopBridgeService, { buildCodexDesktopBridgeSessionPatch, isCodexDesktopBridgeableSession } from './codex-desktop-bridge.js';
import { logger } from './utils/logger.js';

function shouldAutoBridge(session = null, turnId = '') {
  if (!isCodexDesktopBridgeableSession(session)) {
    return false;
  }

  const source = session?.metadata?.source || {};
  if (source.kind !== 'channel') {
    return false;
  }

  const existingBridge = session?.metadata?.codexDesktopBridge || {};
  if (existingBridge.lastBridgedTurnId && String(existingBridge.lastBridgedTurnId) === String(turnId || '')) {
    return false;
  }

  if (existingBridge.threadId && String(existingBridge.threadId) === String(session?.providerSessionId || '')) {
    return false;
  }

  return true;
}

export class CodexDesktopBridgeObserver {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    bridgeService = codexDesktopBridgeService,
    appLogger = logger
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.bridgeService = bridgeService;
    this.logger = appLogger;
    this.unsubscribe = null;
  }

  start() {
    if (this.unsubscribe) {
      return;
    }

    this.unsubscribe = this.runtimeSessionManager.eventBus.subscribeAll((event) => {
      this.handleRuntimeEvent(event).catch(() => {});
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async handleRuntimeEvent(event = null) {
    if (event?.type !== AGENT_EVENT_TYPE.COMPLETED) {
      return;
    }

    const session = this.runtimeSessionManager.getSession(String(event?.sessionId || ''));
    if (!shouldAutoBridge(session, event?.turnId)) {
      return;
    }

    try {
      const bridge = await this.bridgeService.bridgeRuntimeSession({ session, openApp: false });
      this.runtimeSessionManager.updateSession(session.id, buildCodexDesktopBridgeSessionPatch(session, bridge, {
          lastBridgedTurnId: String(event?.turnId || ''),
          autoBridged: true
        }));
      this.logger.info(`[CodexDesktopBridge] Auto-bridged session ${session.id} -> ${bridge.threadId}`);
    } catch (error) {
      this.runtimeSessionManager.updateSessionMetadata(session.id, {
        codexDesktopBridge: buildCodexDesktopBridgeMetadata(session, {}, {
          lastBridgedTurnId: String(event?.turnId || ''),
          autoBridged: true,
          lastError: error.message || 'Failed to bridge session to Codex Desktop',
          failedAt: new Date().toISOString()
        })
      });
      this.logger.warn(`[CodexDesktopBridge] Auto-bridge failed for session ${session.id}: ${error.message}`);
    }
  }
}

export const codexDesktopBridgeObserver = new CodexDesktopBridgeObserver();

export default codexDesktopBridgeObserver;
