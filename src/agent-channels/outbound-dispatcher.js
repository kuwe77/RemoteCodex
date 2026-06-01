import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskTerminalState } from '../agent-core/task-service.js';
import { buildConversationSupervisorPatch } from '../agent-orchestrator/conversation-supervisor-state.js';
import agentChannelConversationStore from './conversation-store.js';
import agentChannelDeliveryStore from './delivery-store.js';
import { formatAgentRuntimeEventForChannel } from './formatter.js';
import agentChannelRegistry from './registry.js';

const NOTIFIABLE_EVENT_TYPES = new Set([
  AGENT_EVENT_TYPE.STARTED,
  AGENT_EVENT_TYPE.MESSAGE,
  AGENT_EVENT_TYPE.APPROVAL_REQUEST,
  AGENT_EVENT_TYPE.QUESTION,
  AGENT_EVENT_TYPE.COMPLETED,
  AGENT_EVENT_TYPE.FAILED
]);

function getLastOutboundDelivery(deliveryStore, conversationId, sessionId) {
  return deliveryStore.listByConversation(conversationId, { limit: 50 })
    .filter((entry) => entry?.direction === 'outbound' && entry?.sessionId === sessionId && entry?.status === 'sent')
    .at(-1) || null;
}

function shouldSuppressTerminalDelivery({
  deliveryStore,
  conversationId,
  sessionId,
  eventType,
  outboundText
} = {}) {
  if (![AGENT_EVENT_TYPE.COMPLETED, AGENT_EVENT_TYPE.FAILED].includes(eventType)) {
    return false;
  }

  const normalizedText = String(outboundText || '').trim();
  if (!normalizedText) {
    return false;
  }

  const previous = getLastOutboundDelivery(deliveryStore, conversationId, sessionId);
  if (!previous) {
    return false;
  }

  const previousText = String(previous?.payload?.fullText || previous?.payload?.text || '').trim();
  const previousEventType = String(previous?.payload?.eventType || '');
  return previousEventType === AGENT_EVENT_TYPE.MESSAGE && previousText === normalizedText;
}

export class AgentChannelOutboundDispatcher {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    conversationStore = agentChannelConversationStore,
    deliveryStore = agentChannelDeliveryStore,
    registry = agentChannelRegistry,
    taskStore = agentTaskStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.registry = registry;
    this.taskStore = taskStore;
    this.unsubscribe = null;
    this.eventQueues = new Map();
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

  handleRuntimeEvent(event) {
    const queueKey = String(event?.sessionId || 'global');
    const previous = this.eventQueues.get(queueKey) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this._handleRuntimeEvent(event));
    const cleanup = next.finally(() => {
      if (this.eventQueues.get(queueKey) === cleanup) {
        this.eventQueues.delete(queueKey);
      }
    });
    this.eventQueues.set(queueKey, cleanup);
    return cleanup;
  }

  async _handleRuntimeEvent(event) {
    if (!NOTIFIABLE_EVENT_TYPES.has(event?.type)) {
      return;
    }

    const conversations = this.conversationStore.listByRuntimeSessionId(event.sessionId);
    if (conversations.length === 0) {
      return;
    }

    const session = this.runtimeSessionManager.getSession(event.sessionId);
    syncTaskTerminalState({
      session,
      event,
      store: this.taskStore
    });

    for (const conversation of conversations) {
      const provider = this.registry.get(conversation.channel, conversation.accountId);
      if (!provider?.sendMessage) {
        continue;
      }

      const formatted = formatAgentRuntimeEventForChannel({ event, session });
      if (!formatted?.text) {
        continue;
      }

      const outboundText = formatted.fullText || formatted.text || '';
      const outboundPayload = {
        ...formatted,
        fullText: outboundText,
        eventType: event.type
      };
      const suppressTerminalDelivery = shouldSuppressTerminalDelivery({
        deliveryStore: this.deliveryStore,
        conversationId: conversation.id,
        sessionId: event.sessionId,
        eventType: event.type,
        outboundText
      });

      try {
        if (!suppressTerminalDelivery) {
          const result = await provider.sendMessage({
            conversation,
            text: outboundText,
            buttons: formatted.buttons || [],
            session,
            event
          });

          this.deliveryStore.saveOutbound({
            channel: conversation.channel,
            conversationId: conversation.id,
            sessionId: event.sessionId,
            eventSeq: event.seq,
            externalMessageId: result?.messageId || '',
            status: 'sent',
            payload: outboundPayload
          });
        }

        if (event.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST) {
          this.conversationStore.patch(conversation.id, {
            lastPendingApprovalId: event?.payload?.approvalId || null
          });
        }

        if (event.type === AGENT_EVENT_TYPE.QUESTION) {
          this.conversationStore.patch(conversation.id, {
            lastPendingQuestionId: event?.payload?.questionId || null
          });
        }

        if (event.type === AGENT_EVENT_TYPE.COMPLETED || event.type === AGENT_EVENT_TYPE.FAILED) {
          this.conversationStore.patch(conversation.id, {
            lastPendingApprovalId: null,
            lastPendingQuestionId: null
          });
        }

        this.conversationStore.patch(
          conversation.id,
          buildConversationSupervisorPatch({ conversation, session, event })
        );
      } catch (error) {
        this.deliveryStore.saveOutbound({
          channel: conversation.channel,
          conversationId: conversation.id,
          sessionId: event.sessionId,
          eventSeq: event.seq,
          status: 'failed',
          error: error.message,
          payload: outboundPayload
        });
      }
    }
  }
}

export const agentChannelOutboundDispatcher = new AgentChannelOutboundDispatcher();

export default agentChannelOutboundDispatcher;
