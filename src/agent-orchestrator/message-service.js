import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentRuntimeApprovalPolicyStore from '../agent-runtime/approval-policy-store.js';
import { AGENT_SESSION_STATUS } from '../agent-runtime/models.js';
import { buildSupervisorBrief } from './supervisor-brief.js';

function withDefaultRuntimeOptions(provider, metadata = {}) {
  const next = { ...(metadata || {}) };
  const runtimeOptions = { ...(next.runtimeOptions || {}) };

  if (provider === 'codex' && String(next.cwd || '').trim()) {
    runtimeOptions.codex = {
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ...(runtimeOptions.codex || {})
    };
  }

  if (Object.keys(runtimeOptions).length > 0) {
    next.runtimeOptions = runtimeOptions;
  }

  return next;
}

function parseLeadingCommand(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) {
    return null;
  }

  const match = text.match(/^\/([a-zA-Z-]+)(?:\s+(.+))?$/s);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: String(match[2] || '').trim()
  };
}

function parseProviderAlias(command, args) {
  const normalized = String(command || '').toLowerCase();
  if (normalized === 'cx') {
    return {
      provider: 'codex',
      input: String(args || '').trim()
    };
  }
  return null;
}

function parseAgentCommand(args) {
  const match = String(args || '').match(/^(codex)\s+(.+)$/is);
  if (!match) return null;
  return {
    provider: 'codex',
    input: String(match[2] || '').trim()
  };
}

function parseRuntimeTarget(args) {
  const command = parseLeadingCommand(`/${String(args || '').trim()}`);
  const alias = parseProviderAlias(command?.command, command?.args);
  if (alias) {
    return alias;
  }
  return parseAgentCommand(args);
}

function buildResetResponse(message, activeSessionId = null) {
  return {
    type: 'conversation_reset',
    message,
    previousSessionId: activeSessionId || null
  };
}

function providerLabel(providerId) {
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function getTaskMemory(conversation) {
  return conversation?.metadata?.supervisor?.taskMemory || null;
}

function getSupervisorBrief(conversation, session = null) {
  const existing = conversation?.metadata?.supervisor?.brief;
  if (existing && typeof existing === 'object' && existing.kind) {
    return existing;
  }
  return buildSupervisorBrief({
    taskMemory: getTaskMemory(conversation),
    session
  });
}

function getPreferredConversationProvider(conversation, session = null, defaultRuntimeProvider = 'codex') {
  const brief = getSupervisorBrief(conversation, session);
  return String(session?.provider || brief?.provider || defaultRuntimeProvider || 'codex');
}

function isPreferenceMemoryIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return /(è®°ä½|ä»¥åŽ|åŽç»­|é»˜è®¤|æ€»æ˜¯|prefer|always|default)/i.test(text)
    && /(ä¸­æ–‡|è‹±æ–‡|codex|ç®€æ´|è¯¦ç»†|æœ€å°æ”¹åŠ¨|concise|detailed|minimal)/i.test(text);
}

function buildSupervisorStatusResponse(conversation, session = null) {
  const brief = getSupervisorBrief(conversation, session);

  if (brief.kind !== 'empty') {
    return {
      type: 'supervisor_status',
      message: [
        `${brief.kind === 'current' ? 'Current task' : 'Remembered task'}: ${brief.title || 'Untitled task'}`,
        `Provider: ${brief.providerLabel || providerLabel(brief.provider)}`,
        `Status: ${brief.status || 'unknown'}`,
        brief.summary ? `Summary: ${brief.summary}` : null,
        brief.result ? `Latest result: ${String(brief.result).slice(0, 400)}` : null,
        brief.error ? `Error: ${brief.error}` : null,
        brief.waitingReason ? `Waiting on: ${brief.waitingReason}` : null,
        brief.nextSuggestion ? `Next: ${brief.nextSuggestion}` : null
      ].filter(Boolean).join('\n')
    };
  }

  return {
    type: 'command_error',
    message: 'No remembered task status is available for this conversation yet.'
  };
}

function shouldStartFreshFromRememberedContext(brief = null) {
  if (!brief || typeof brief !== 'object') return false;
  return ['last_completed', 'last_failed'].includes(String(brief.kind || ''));
}

function buildRememberedContextMessage(brief = null) {
  const sourceTitle = String(brief?.title || '').trim();
  if (!sourceTitle) {
    return 'Started a fresh task using remembered conversation context.';
  }
  return `Started a fresh task using remembered conversation context from "${sourceTitle}".`;
}

function buildRememberedSupervisorContext(brief = null) {
  return {
    kind: 'direct',
    title: '',
    summary: '',
    sourceTitle: String(brief?.title || '').trim(),
    sourceProvider: String(brief?.provider || '').trim(),
    sourceStatus: String(brief?.status || '').trim()
  };
}

function summarizeSessionText(value, maxLength = 56) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'Untitled task';
  }
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildSessionListMessage(sessions = [], activeSessionId = '') {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return 'No saved runtime sessions were found for this Telegram chat yet.';
  }

  const lines = ['Recent sessions for this chat:'];
  for (const session of sessions) {
    const isActive = String(session?.id || '') === String(activeSessionId || '');
    lines.push(
      `${isActive ? '* ' : '- '}${String(session?.id || '').slice(0, 8)} | ${providerLabel(session?.provider)} | ${String(session?.status || 'unknown')} | ${summarizeSessionText(session?.title || session?.summary)}`
    );
  }
  lines.push('Use /resume <session-id-or-prefix> to attach one of them.');
  return lines.join('\n');
}

function buildBusyResponse(session, conversation = null) {
  const current = session || {};
  const brief = getSupervisorBrief(conversation, session);
  const intro = brief?.title
    ? `${brief.providerLabel || providerLabel(current.provider || brief.provider)} is still busy with "${brief.title}".`
    : `I am still working on the current task with ${providerLabel(current.provider)}.`;

  if (current.status === AGENT_SESSION_STATUS.WAITING_APPROVAL) {
    return {
      type: 'command_error',
      message: `${intro} It is waiting on a permission decision from you.${brief?.waitingReason ? ` ${brief.waitingReason}.` : ''} Reply with /approve, /deny, or a natural-language reply like â€œåŒæ„â€ / â€œæ‹’ç»â€.`
    };
  }

  if (current.status === AGENT_SESSION_STATUS.WAITING_USER) {
    return {
      type: 'command_error',
      message: `${intro} It still needs your answer before it can continue.${brief?.waitingReason ? ` ${brief.waitingReason}.` : ''} Reply directly to that question and I will pass it along.`
    };
  }

  return {
    type: 'command_error',
    message: `${intro}${brief?.summary ? ` ${brief.summary}.` : ''} Wait for that run to finish, ask for a status update, or send /cancel if you want me to stop it first.`
  };
}

function isSessionBusy(session) {
  return [
    AGENT_SESSION_STATUS.RUNNING,
    AGENT_SESSION_STATUS.WAITING_APPROVAL,
    AGENT_SESSION_STATUS.WAITING_USER,
    AGENT_SESSION_STATUS.STARTING
  ].includes(session?.status);
}

function normalizeDecisionText(input) {
  return String(input || '').trim().toLowerCase();
}

function isApprovalAffirmative(input) {
  const text = normalizeDecisionText(input);
  return /^(åŒæ„|å¯ä»¥|å…è®¸|ç»§ç»­|è¡Œ|ç¡®è®¤)(?:\s|$|è¿™|è¯¥|åŽ|æœ¬|ç»™|è®©|å§)/.test(text)
    || /^(approve|ok|okay|yes|y)\b/.test(text);
}

function isApprovalNegative(input) {
  const text = normalizeDecisionText(input);
  return /^(æ‹’ç»|ä¸è¡Œ|ä¸è¦|åœæ­¢)(?:\s|$|è¿™|è¯¥|åŽ|æœ¬|ç»™|è®©|å§)/.test(text)
    || /^(deny|no|n)\b/.test(text);
}

function wantsRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(åŽç»­|ä»¥åŽ|æœ¬ä¼šè¯|åˆ«å†é—®|éƒ½å…è®¸|å…¨éƒ¨å…è®¸|this session|from now on|remember|don'?t ask again)/i.test(text);
}

function wantsConversationRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(è¿™ä¸ªå¯¹è¯|è¿™æ¬¡å¯¹è¯|å½“å‰å¯¹è¯|è¿™ä¸ªèŠå¤©|è¿™æ¡ä¼šè¯|this conversation|this chat|ä»¥åŽéƒ½|åŽç»­éƒ½|åˆ«å†é—®)/i.test(text);
}

export class AgentOrchestratorMessageService {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    approvalPolicyStore = agentRuntimeApprovalPolicyStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.approvalPolicyStore = approvalPolicyStore;
  }

  async startRuntimeTask({ provider, input, cwd, model = '', metadata = {}, inputAttachments = [] } = {}) {
    return this.runtimeSessionManager.createSession({
      provider,
      input,
      cwd,
      model,
      metadata: withDefaultRuntimeOptions(provider, {
        ...(metadata || {}),
        cwd
      }),
      inputAttachments
    });
  }

  async continueRuntimeTask({ sessionId, input, inputAttachments = [] } = {}) {
    return this.runtimeSessionManager.sendInput(String(sessionId || ''), input, {
      inputAttachments
    });
  }

  async resolveApproval({ sessionId, approvalId, decision } = {}) {
    return this.runtimeSessionManager.resolveApproval(
      String(sessionId || ''),
      String(approvalId || ''),
      String(decision || '')
    );
  }

  async answerQuestion({ sessionId, questionId, answer } = {}) {
    return this.runtimeSessionManager.answerQuestion(
      String(sessionId || ''),
      String(questionId || ''),
      answer
    );
  }

  cancelRuntimeSession({ sessionId } = {}) {
    return this.runtimeSessionManager.cancelSession(String(sessionId || ''));
  }

  getRuntimeSession(sessionId) {
    return this.runtimeSessionManager.getSession(String(sessionId || ''));
  }

  listPendingQuestions(sessionId) {
    return this.runtimeSessionManager.listPendingQuestions(String(sessionId || ''));
  }

  listPendingApprovals(sessionId) {
    return this.runtimeSessionManager.approvalService.listPending(String(sessionId || ''));
  }

  listConversationSessions(conversationId, { limit = 8 } = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return [];
    }

    if (typeof this.runtimeSessionManager.listSessionsByConversationId === 'function') {
      return this.runtimeSessionManager.listSessionsByConversationId(normalizedConversationId, { limit });
    }

    return this.runtimeSessionManager.listSessions({ limit: Math.max(limit * 10, 100) })
      .filter((session) => String(
        session?.metadata?.source?.conversationId
          || session?.metadata?.conversationId
          || ''
      ).trim() === normalizedConversationId)
      .slice(0, Math.max(1, limit));
  }

  resolveConversationSession(conversationId, target = '') {
    const normalizedTarget = String(target || '').trim().toLowerCase();
    if (!normalizedTarget) {
      return {
        session: null,
        error: 'Usage: /resume <session-id-or-prefix>'
      };
    }

    const sessions = this.listConversationSessions(conversationId, { limit: 50 });
    if (normalizedTarget === 'latest' || normalizedTarget === 'last') {
      return {
        session: sessions[0] || null,
        error: sessions[0] ? '' : 'No saved runtime sessions were found for this chat.'
      };
    }

    const exact = sessions.find((session) => String(session?.id || '').toLowerCase() === normalizedTarget);
    if (exact) {
      return { session: exact, error: '' };
    }

    const matches = sessions.filter((session) => String(session?.id || '').toLowerCase().startsWith(normalizedTarget));
    if (matches.length === 1) {
      return { session: matches[0], error: '' };
    }
    if (matches.length > 1) {
      return {
        session: null,
        error: `Multiple sessions match "${target}". Try a longer id: ${matches.slice(0, 5).map((session) => String(session.id || '').slice(0, 8)).join(', ')}`
      };
    }

    return {
      session: null,
      error: `No saved runtime session in this chat matches "${target}".`
    };
  }

  async routeUserMessage({
    message,
    conversation = null,
    defaultRuntimeProvider = 'codex',
    cwd,
    model = '',
    metadata = {}
  } = {}) {
    const text = String(message?.text || '').trim();
    if (!text) {
      throw new Error('message text is required');
    }
    const inputAttachments = Array.isArray(message?.metadata?.attachments)
      ? message.metadata.attachments
      : [];

    const parsed = parseLeadingCommand(text);
    const activeSessionId = conversation?.activeRuntimeSessionId || null;
    const pendingApprovalId = conversation?.lastPendingApprovalId || null;
    const pendingQuestionId = conversation?.lastPendingQuestionId || null;
    const activeSession = activeSessionId ? this.getRuntimeSession(activeSessionId) : null;
    const supervisorBrief = getSupervisorBrief(conversation, activeSession);
    const preferredProvider = 'codex';

    if (activeSessionId && pendingApprovalId && !parsed?.command) {
      const approval = this.runtimeSessionManager.approvalService.getApproval(activeSessionId, pendingApprovalId);
      if (approval && approval.status === 'pending') {
        if (isApprovalAffirmative(text) || isApprovalNegative(text)) {
          let policy = null;
          if (isApprovalAffirmative(text) && wantsRememberedApproval(text)) {
            const scope = wantsConversationRememberedApproval(text) && conversation?.id
              ? 'conversation'
              : 'runtime_session';
            const scopeRef = scope === 'conversation' ? conversation.id : activeSessionId;
            policy = this.approvalPolicyStore.createPolicy({
              scope,
              scopeRef,
              provider: activeSession?.provider || 'codex',
              toolName: approval?.toolName || approval?.title || '',
              metadata: {
                approvalId: approval?.id || pendingApprovalId
              }
            });
          }

          const resolved = await this.resolveApproval({
            sessionId: activeSessionId,
            approvalId: pendingApprovalId,
            decision: isApprovalAffirmative(text) ? 'approve' : 'deny'
          });

          return {
            type: 'approval_resolved',
            approval: resolved,
            policy,
            message: policy
              ? (policy.scope === 'conversation'
                ? 'Approved. I will remember this permission for this conversation.'
                : 'Approved. I will remember this permission for the current session.')
              : (resolved.status === 'approved' ? 'Approved.' : 'Denied.')
          };
        }
      }
    }

    const aliased = parseProviderAlias(parsed?.command, parsed?.args);
    if (aliased) {
      if (!aliased.input) {
        return {
          type: 'command_error',
          message: 'Usage: /cx <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: aliased.provider,
        input: aliased.input,
        cwd,
        model,
        metadata,
        inputAttachments
      });

      return {
        type: 'runtime_started',
        provider: aliased.provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'agent') {
      const spec = parseAgentCommand(parsed.args);
      if (!spec) {
        return {
          type: 'command_error',
          message: 'Usage: /agent codex <task> or /cx <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: spec.provider,
        input: spec.input,
        cwd,
        model,
        metadata,
        inputAttachments
      });

      return {
        type: 'runtime_started',
        provider: spec.provider,
        session
      };
    }

    if (parsed?.command === 'sessions') {
      if (!conversation?.id) {
        return {
          type: 'command_error',
          message: 'No conversation history is available in this chat yet.'
        };
      }

      const sessions = this.listConversationSessions(conversation.id, { limit: 8 });
      return {
        type: 'session_list',
        sessions,
        message: buildSessionListMessage(sessions, activeSessionId)
      };
    }

    if (parsed?.command === 'resume') {
      if (!conversation?.id) {
        return {
          type: 'command_error',
          message: 'No conversation history is available in this chat yet.'
        };
      }

      const [targetToken, ...followUpParts] = String(parsed.args || '').trim().split(/\s+/).filter(Boolean);
      const resolved = this.resolveConversationSession(conversation.id, targetToken);
      if (resolved.error) {
        return {
          type: 'command_error',
          message: resolved.error
        };
      }

      const targetSession = resolved.session;
      if (!targetSession) {
        return {
          type: 'command_error',
          message: 'No saved runtime session was found.'
        };
      }

      if (followUpParts.length > 0) {
        if (isSessionBusy(targetSession)) {
          return {
            type: 'runtime_resumed',
            session: targetSession,
            resumedSessionId: targetSession.id,
            replacedSessionId: activeSessionId,
            message: `Attached session ${targetSession.id}. It is still busy, so I did not send your follow-up yet.`
          };
        }

        const session = await this.continueRuntimeTask({
          sessionId: targetSession.id,
          input: followUpParts.join(' '),
          inputAttachments
        });
        return {
          type: 'runtime_continued',
          session,
          resumedSessionId: targetSession.id,
          replacedSessionId: activeSessionId,
          message: `Resumed session ${session.id} and sent your follow-up.`
        };
      }

      return {
        type: 'runtime_resumed',
        session: targetSession,
        resumedSessionId: targetSession.id,
        replacedSessionId: activeSessionId,
        message: String(activeSessionId || '') === String(targetSession.id || '')
          ? `Session ${targetSession.id} is already active in this chat.`
          : `Attached session ${targetSession.id}. Your next message will continue it.`
      };
    }

    if (parsed?.command === 'new') {
      if (!parsed.args) {
        return buildResetResponse(
          activeSessionId
            ? 'Detached the active runtime session. Your next message will start a fresh task.'
            : 'No active runtime session is attached. Your next message will start a fresh task.',
          activeSessionId
        );
      }

      const spec = parseRuntimeTarget(parsed.args);
      const provider = spec?.provider || defaultRuntimeProvider;
      const input = spec?.input || parsed.args;
      const session = await this.startRuntimeTask({
        provider,
        input,
        cwd,
        model,
        metadata,
        inputAttachments
      });

      return {
        type: 'runtime_started',
        provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'detach') {
      return buildResetResponse(
        activeSessionId
          ? 'Detached the active runtime session from this conversation.'
          : 'No active runtime session is attached to this conversation.',
        activeSessionId
      );
    }

    if (parsed?.command === 'continue') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to continue'
        };
      }
      const activeSession = this.getRuntimeSession(activeSessionId);
      if (isSessionBusy(activeSession)) {
        return buildBusyResponse(activeSession);
      }
      const session = await this.continueRuntimeTask({
        sessionId: activeSessionId,
        input: parsed.args || text,
        inputAttachments
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (parsed?.command === 'cancel') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to cancel'
        };
      }
      return {
        type: 'runtime_cancelled',
        session: this.cancelRuntimeSession({ sessionId: activeSessionId })
      };
    }

    if (parsed?.command === 'status') {
      if (!activeSessionId) {
        return buildSupervisorStatusResponse(conversation, null);
      }
      return {
        type: 'runtime_status',
        session: activeSession
      };
    }

    if (parsed?.command === 'approve' || parsed?.command === 'deny') {
      if (!activeSessionId || !pendingApprovalId) {
        return {
          type: 'command_error',
          message: 'No pending approval request'
        };
      }
      const approval = await this.resolveApproval({
        sessionId: activeSessionId,
        approvalId: pendingApprovalId,
        decision: parsed.command === 'approve' ? 'approve' : 'deny'
      });
      return {
        type: 'approval_resolved',
        approval,
        message: parsed.command === 'approve' ? 'Approved.' : 'Denied.'
      };
    }

    if (activeSessionId && pendingQuestionId) {
      const question = await this.answerQuestion({
        sessionId: activeSessionId,
        questionId: pendingQuestionId,
        answer: text
      });
      return {
        type: 'question_answered',
        question
      };
    }

    if (activeSessionId) {
      if (isSessionBusy(activeSession)) {
        return buildBusyResponse(activeSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        sessionId: activeSessionId,
        input: text,
        inputAttachments
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    const session = await this.startRuntimeTask({
      provider: preferredProvider,
      input: text,
      cwd,
      model,
      metadata,
      inputAttachments
    });

    if (shouldStartFreshFromRememberedContext(supervisorBrief)) {
      return {
        type: 'runtime_started',
        provider: preferredProvider,
        session,
        startedFresh: true,
        message: buildRememberedContextMessage(supervisorBrief),
        supervisorContext: buildRememberedSupervisorContext(supervisorBrief)
      };
    }

    return {
      type: 'runtime_started',
      provider: preferredProvider,
      session
    };
  }
}

export const agentOrchestratorMessageService = new AgentOrchestratorMessageService();

export default agentOrchestratorMessageService;


