import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getStatus, ACCOUNTS_FILE } from '../account-manager.js';
import { handleGetLogs, handleStreamLogs } from './logs-route.js';
import {
  handleListAgentRuntimeProviders,
  handleListAgentRuntimeSessions,
  handleGetAgentRuntimeSession,
  handleGetAgentRuntimeTurn,
  handleCreateAgentRuntimeSession,
  handleSendAgentRuntimeInput,
  handleResolveAgentRuntimeApproval,
  handleAnswerAgentRuntimeQuestion,
  handleCancelAgentRuntimeSession,
  handleBridgeAgentRuntimeSessionToCodexDesktop,
  handleStreamAgentRuntimeSession
} from './agent-runtimes-route.js';
import {
  handleListAgentChannelProviders,
  handleGetAgentChannelCatalog,
  handleGetAgentChannelSettings,
  handleCreateAgentChannelInstance,
  handleUpdateAgentChannelSettings,
  handleDeleteAgentChannelInstance,
  handleRefreshAgentChannels,
  handleListAgentChannelConversations,
  handleGetAgentChannelConversation,
  handleListAgentChannelSessionRecords,
  handleGetAgentChannelSessionRecord,
  handleResetAgentChannelConversation,
  handleApproveAgentChannelPairing,
  handleDenyAgentChannelPairing
} from './agent-channels-route.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerApiRoutes(app, { port }) {
  const publicDir = join(__dirname, '..', '..', 'public');
  const staticDir = publicDir.includes('app.asar')
    ? publicDir.replace('app.asar', 'app.asar.unpacked')
    : publicDir;
  app.use(express.static(staticDir));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ...getStatus(), configPath: ACCOUNTS_FILE });
  });

  app.get('/api/logs', handleGetLogs);
  app.get('/api/logs/stream', handleStreamLogs);

  app.get('/api/agent-runtimes/providers', handleListAgentRuntimeProviders);
  app.get('/api/agent-runtimes/sessions', handleListAgentRuntimeSessions);
  app.post('/api/agent-runtimes/sessions', handleCreateAgentRuntimeSession);
  app.get('/api/agent-runtimes/sessions/:id', handleGetAgentRuntimeSession);
  app.get('/api/agent-runtimes/sessions/:id/turns/:turnId', handleGetAgentRuntimeTurn);
  app.get('/api/agent-runtimes/sessions/:id/stream', handleStreamAgentRuntimeSession);
  app.post('/api/agent-runtimes/sessions/:id/input', handleSendAgentRuntimeInput);
  app.post('/api/agent-runtimes/sessions/:id/approval', handleResolveAgentRuntimeApproval);
  app.post('/api/agent-runtimes/sessions/:id/question', handleAnswerAgentRuntimeQuestion);
  app.post('/api/agent-runtimes/sessions/:id/cancel', handleCancelAgentRuntimeSession);
  app.post('/api/agent-runtimes/sessions/:id/bridge/codex-desktop', handleBridgeAgentRuntimeSessionToCodexDesktop);

  app.get('/api/agent-channels/providers', handleListAgentChannelProviders);
  app.get('/api/agent-channels/catalog', handleGetAgentChannelCatalog);
  app.get('/api/agent-channels/settings', handleGetAgentChannelSettings);
  app.post('/api/agent-channels/settings/:channel', handleCreateAgentChannelInstance);
  app.put('/api/agent-channels/settings/:channel/:instanceId', handleUpdateAgentChannelSettings);
  app.delete('/api/agent-channels/settings/:channel/:instanceId', handleDeleteAgentChannelInstance);
  app.post('/api/agent-channels/refresh', handleRefreshAgentChannels);
  app.get('/api/agent-channels/session-records', handleListAgentChannelSessionRecords);
  app.get('/api/agent-channels/session-records/:id', handleGetAgentChannelSessionRecord);
  app.get('/api/agent-channels/conversations', handleListAgentChannelConversations);
  app.get('/api/agent-channels/conversations/:id', handleGetAgentChannelConversation);
  app.post('/api/agent-channels/conversations/:id/reset', handleResetAgentChannelConversation);
  app.post('/api/agent-channels/pairing/:channel/:conversationId/approve', handleApproveAgentChannelPairing);
  app.post('/api/agent-channels/pairing/:channel/:conversationId/deny', handleDenyAgentChannelPairing);
}

export default { registerApiRoutes };
