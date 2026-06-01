import { mkdir, writeFile } from 'fs/promises';
import { extname, join } from 'path';

import { createNormalizedChannelMessage } from '../models.js';
import { CONFIG_DIR } from '../../account-manager.js';

const TELEGRAM_SAFE_MESSAGE_LIMIT = 3500;
const TELEGRAM_MEDIA_DIR = 'telegram-media';
const TELEGRAM_IMAGE_FALLBACK_PROMPT = 'Please analyze the attached image.';
const TELEGRAM_MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g;

function sanitizePathSegment(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function selectLargestPhoto(message = {}) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length === 0) {
    return null;
  }
  return photos[photos.length - 1] || null;
}

function pickTelegramImageSource(message = {}) {
  const photo = selectLargestPhoto(message);
  if (photo?.file_id) {
    return {
      kind: 'photo',
      fileId: String(photo.file_id),
      fileUniqueId: String(photo.file_unique_id || ''),
      mimeType: 'image/jpeg'
    };
  }

  const document = message?.document;
  if (document?.file_id && /^image\//i.test(String(document.mime_type || ''))) {
    return {
      kind: 'document',
      fileId: String(document.file_id),
      fileUniqueId: String(document.file_unique_id || ''),
      mimeType: String(document.mime_type || 'image/jpeg'),
      fileName: String(document.file_name || '')
    };
  }

  return null;
}

function inferExtension({ filePath = '', fileName = '', mimeType = '' } = {}) {
  const filePathExtension = extname(String(filePath || '')).trim();
  if (filePathExtension) {
    return filePathExtension;
  }

  const fileNameExtension = extname(String(fileName || '')).trim();
  if (fileNameExtension) {
    return fileNameExtension;
  }

  const normalizedMimeType = String(mimeType || '').toLowerCase();
  if (normalizedMimeType === 'image/png') return '.png';
  if (normalizedMimeType === 'image/webp') return '.webp';
  if (normalizedMimeType === 'image/gif') return '.gif';
  return '.jpg';
}

function buildDisplayName(from = {}) {
  return from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id || '');
}

function mapCallbackDataToText(data) {
  const raw = String(data || '');
  if (raw.startsWith('remotecodex:approve')) {
    return '/approve';
  }
  if (raw.startsWith('remotecodex:deny')) {
    return '/deny';
  }
  return raw;
}

function providerLabel(providerId) {
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function buildRouterResultText(result) {
  switch (result?.type) {
    case 'pairing_required':
      return `Pairing required. Code: ${result?.pairing?.code || ''}`.trim();
    case 'command_error':
      return result.message || 'Command error';
    case 'runtime_started':
      if (result?.message) {
        return `${result.message}\nSession ${result?.session?.id || ''} started with ${providerLabel(result?.session?.provider || result?.provider)}.`.trim();
      }
      if (result?.startedFresh && result?.replacedSessionId) {
        return `Started a fresh task with ${providerLabel(result?.session?.provider || result?.provider)}. Previous session ${result.replacedSessionId} was detached. New session: ${result?.session?.id || ''}`.trim();
      }
      return `Task accepted. Session ${result?.session?.id || ''} started with ${providerLabel(result?.session?.provider || result?.provider)}.`.trim();
    case 'runtime_continued':
      if (result?.message) {
        return `${result.message}\nSent follow-up to session ${result?.session?.id || ''}.`.trim();
      }
      return `Sent follow-up to session ${result?.session?.id || ''}.`.trim();
    case 'runtime_resumed':
      return result?.message || `Attached session ${result?.session?.id || ''}.`.trim();
    case 'runtime_cancelled':
      return `Session ${result?.session?.id || ''} cancelled.`.trim();
    case 'session_list':
      return result?.message || 'No saved runtime sessions were found.';
    case 'conversation_reset':
      return result?.message || 'Runtime session detached.';
    case 'runtime_status':
      return `Session ${result?.session?.id || ''}: ${result?.session?.status || 'unknown'}${result?.session?.summary ? `\n${result.session.summary}` : ''}`.trim();
    case 'supervisor_status':
      return result?.message || 'No supervisor status available.';
    case 'approval_resolved':
      return result?.message || `Approval ${result?.approval?.status || 'resolved'}.`;
    case 'question_answered':
      return 'Answer sent to the active task.';
    case 'preference_saved':
      return result?.message || 'Preference saved.';
    case 'assistant_mode_entered':
    case 'assistant_mode_exited':
    case 'assistant_run_accepted':
    case 'assistant_response':
      return result?.message || '';
    default:
      return '';
  }
}

function splitTelegramText(text, maxLength = TELEGRAM_SAFE_MESSAGE_LIMIT) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) {
    return [''];
  }

  if (source.length <= maxLength) {
    return [source];
  }

  const chunks = [];
  let remaining = source;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => {
    const prefix = `[${index + 1}/${chunks.length}] `;
    return `${prefix}${chunk}`;
  });
}

function parseTelegramLocalFileLinkTarget(rawTarget = '') {
  const normalizedTarget = String(rawTarget || '').trim().replace(/^<|>$/g, '');
  if (!normalizedTarget) {
    return null;
  }

  const localPathTarget = normalizedTarget.replace(/^\/(?=[A-Za-z]:[\\/])/, '');
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(localPathTarget);
  const isUnixPath = /^\/(?:Users|home|tmp|var|private|mnt|opt|workspace)\//.test(localPathTarget);
  if (!isWindowsPath && !isUnixPath) {
    return null;
  }

  const lineMatch = localPathTarget.match(/:(\d+)$/);
  return {
    line: lineMatch ? Number(lineMatch[1]) : null
  };
}

function formatTelegramText(text) {
  const source = String(text || '');
  if (!source) {
    return '';
  }

  return source.replace(TELEGRAM_MARKDOWN_LINK_PATTERN, (match, label, rawTarget) => {
    const fileLink = parseTelegramLocalFileLinkTarget(rawTarget);
    if (!fileLink) {
      return match;
    }

    const cleanLabel = String(label || '').trim() || 'file';
    if (Number.isFinite(fileLink.line) && fileLink.line > 0) {
      return `${cleanLabel} (line ${fileLink.line})`;
    }

    return cleanLabel;
  });
}

export class TelegramChannelProvider {
  constructor({ fetchImpl = globalThis.fetch, configDir = CONFIG_DIR } = {}) {
    this.id = 'telegram';
    this.label = 'Telegram';
    this.fetchImpl = fetchImpl;
    this.configDir = configDir;
    this.capabilities = {
      mode: 'polling',
      supportedModes: ['polling'],
      supportsWebhook: true,
      supportsPolling: true,
      supportsInteractiveApproval: true,
      supportsRichCard: false,
      supportsThreading: false,
      supportsEditMessage: true
    };
    this.configFields = [
      { key: 'enabled', type: 'boolean', labelKey: 'channelEnabled', section: 'basic' },
      { key: 'mode', type: 'select', labelKey: 'channelMode', section: 'basic', options: [{ value: 'polling', labelKey: 'channelModePolling' }] },
      { key: 'botToken', type: 'password', labelKey: 'channelBotToken', placeholderKey: 'channelBotTokenPlaceholder', section: 'auth' },
      { key: 'pollingIntervalMs', type: 'number', labelKey: 'channelPollInterval', section: 'transport' },
      { key: 'defaultRuntimeProvider', type: 'runtime-provider', labelKey: 'channelDefaultRuntime', section: 'runtime' },
      { key: 'model', type: 'text', labelKey: 'chatModel', placeholderKey: 'chatModelPlaceholder', section: 'runtime' },
      { key: 'cwd', type: 'text', labelKey: 'channelWorkingDirectory', section: 'runtime' },
      { key: 'requirePairing', type: 'boolean', labelKey: 'channelRequirePairing', section: 'security' }
    ];
    this.running = false;
    this.timer = null;
    this.pollInFlight = false;
    this.offset = 0;
    this.router = null;
    this.settings = null;
    this.logger = console;
  }

  getStatus() {
    return {
      running: this.running,
      mode: this.settings?.mode || this.capabilities.mode,
      offset: this.offset
    };
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;

    if (!this.fetchImpl) {
      return { started: false, reason: 'fetch is unavailable' };
    }
    if (!this.settings?.botToken) {
      return { started: false, reason: 'telegram botToken is not configured' };
    }
    if ((this.settings.mode || 'polling') !== 'polling') {
      return { started: false, reason: `unsupported telegram mode: ${this.settings.mode}` };
    }

    this.running = true;
    this._scheduleNextPoll(0);
    return { started: true };
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return { stopped: true };
  }

  async callApi(method, payload = {}) {
    if (!this.settings?.botToken) {
      throw new Error('telegram botToken is not configured');
    }
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.settings.botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.description || `Telegram API ${method} failed`);
    }
    return data.result;
  }

  async fetchFile(filePath) {
    const response = await this.fetchImpl(
      `https://api.telegram.org/file/bot${this.settings.botToken}/${String(filePath || '').replace(/^\/+/, '')}`,
      {
        method: 'GET'
      }
    );

    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async downloadMessageImage(message = {}) {
    const source = pickTelegramImageSource(message);
    if (!source?.fileId) {
      return null;
    }

    const file = await this.callApi('getFile', {
      file_id: source.fileId
    });
    const filePath = String(file?.file_path || '').trim();
    if (!filePath) {
      throw new Error('Telegram getFile returned no file_path');
    }

    const content = await this.fetchFile(filePath);
    const extension = inferExtension({
      filePath,
      fileName: source.fileName,
      mimeType: source.mimeType
    });
    const chatSegment = sanitizePathSegment(message?.chat?.id, 'chat');
    const messageSegment = sanitizePathSegment(message?.message_id, 'message');
    const fileSegment = sanitizePathSegment(source.fileUniqueId || source.fileId, 'file');
    const outputDir = join(this.configDir, 'agent-channels', TELEGRAM_MEDIA_DIR, this.instanceId || 'default', chatSegment);

    await mkdir(outputDir, { recursive: true, mode: 0o700 });

    const outputPath = join(outputDir, `${messageSegment}-${fileSegment}${extension}`);
    await writeFile(outputPath, content, { mode: 0o600 });

    return {
      kind: 'image',
      source: 'telegram',
      localPath: outputPath,
      mimeType: source.mimeType,
      telegram: {
        fileId: source.fileId,
        fileUniqueId: source.fileUniqueId,
        filePath
      }
    };
  }

  _scheduleNextPoll(delayMs = null) {
    if (!this.running) {
      return;
    }
    const waitMs = Number.isFinite(Number(delayMs))
      ? Number(delayMs)
      : Number(this.settings?.pollingIntervalMs || 2000);
    this.timer = setTimeout(() => {
      this.pollOnce().catch((error) => {
        this.logger?.warn?.(`[TelegramChannel] Poll failed: ${error.message}`);
      });
    }, Math.max(0, waitMs));
  }

  async normalizeInbound(update) {
    if (update?.message?.text) {
      const message = update.message;
      return createNormalizedChannelMessage({
        channel: 'telegram',
        accountId: this.instanceId || 'default',
        deliveryMode: 'polling',
        externalMessageId: String(message.message_id || ''),
        externalConversationId: String(message.chat?.id || ''),
        externalUserId: String(message.from?.id || ''),
        externalUserName: buildDisplayName(message.from),
        text: String(message.text || ''),
        messageType: 'text',
        raw: update
      });
    }

    if (update?.message) {
      const message = update.message;
      const caption = String(message.caption || '').trim();
      const hasImageSource = Boolean(pickTelegramImageSource(message));
      let imageAttachment = null;
      let attachmentError = '';

      if (hasImageSource) {
        imageAttachment = await this.downloadMessageImage(message).catch((error) => {
          attachmentError = error.message || 'Failed to download inbound image';
          this.logger?.warn?.(`[TelegramChannel] Failed to download inbound image: ${attachmentError}`);
          return null;
        });
      }

      if (imageAttachment || hasImageSource) {
        return createNormalizedChannelMessage({
          channel: 'telegram',
          accountId: this.instanceId || 'default',
          deliveryMode: 'polling',
          externalMessageId: String(message.message_id || ''),
          externalConversationId: String(message.chat?.id || ''),
          externalUserId: String(message.from?.id || ''),
          externalUserName: buildDisplayName(message.from),
          text: caption || TELEGRAM_IMAGE_FALLBACK_PROMPT,
          messageType: imageAttachment ? 'image' : 'text',
          metadata: {
            attachments: imageAttachment ? [imageAttachment] : [],
            caption,
            attachmentErrors: attachmentError ? [attachmentError] : []
          },
          raw: update
        });
      }
    }

    if (update?.callback_query?.data) {
      const callback = update.callback_query;
      return createNormalizedChannelMessage({
        channel: 'telegram',
        accountId: this.instanceId || 'default',
        deliveryMode: 'polling',
        externalMessageId: String(callback.id || ''),
        externalConversationId: String(callback.message?.chat?.id || ''),
        externalUserId: String(callback.from?.id || ''),
        externalUserName: buildDisplayName(callback.from),
        text: mapCallbackDataToText(callback.data),
        messageType: 'action',
        action: {
          type: 'callback_query',
          callbackQueryId: String(callback.id || ''),
          data: String(callback.data || '')
        },
        raw: update
      });
    }

    return null;
  }

  async pollOnce() {
    if (!this.running || this.pollInFlight) {
      return 0;
    }

    this.pollInFlight = true;
    try {
      const updates = await this.callApi('getUpdates', {
        offset: this.offset > 0 ? this.offset : undefined,
        timeout: 0,
        allowed_updates: ['message', 'callback_query']
      });

      let processed = 0;
      for (const update of updates || []) {
        if (Number.isFinite(Number(update?.update_id))) {
          this.offset = Number(update.update_id) + 1;
        }

        const inbound = await this.normalizeInbound(update);
        if (!inbound) {
          continue;
        }

        const result = await this.router.routeInboundMessage(inbound, {
          defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
          requirePairing: this.settings?.requirePairing === true,
          cwd: this.settings?.cwd || '',
          model: this.settings?.model || ''
        });

        await this.handleRouterResult(inbound, result);
        if (inbound.action?.type === 'callback_query') {
          await this.answerCallback({
            callbackQueryId: inbound.action.callbackQueryId,
            text: 'Processed'
          });
        }
        processed += 1;
      }

      return processed;
    } finally {
      this.pollInFlight = false;
      if (this.running) {
        this._scheduleNextPoll();
      }
    }
  }

  async handleRouterResult(inbound, result) {
    const text = buildRouterResultText(result);
    if (!text || result?.type === 'duplicate') {
      return null;
    }

    return this.sendMessage({
      conversation: {
        externalConversationId: inbound.externalConversationId
      },
      text
    });
  }

  async sendMessage({ conversation, text, buttons = [] } = {}) {
    const textChunks = splitTelegramText(formatTelegramText(text));
    let result = null;

    for (let index = 0; index < textChunks.length; index += 1) {
      const payload = {
        chat_id: conversation?.externalConversationId,
        text: textChunks[index]
      };

      if (buttons.length > 0 && index === textChunks.length - 1) {
        payload.reply_markup = {
          inline_keyboard: [
            buttons.map((button) => ({
              text: button.text,
              callback_data: `remotecodex:${button.action || button.id || 'action'}:${button.approvalId || ''}`
            }))
          ]
        };
      }

      result = await this.callApi('sendMessage', payload);
    }

    return {
      messageId: String(result?.message_id || '')
    };
  }

  async editMessage({ conversation, messageId, text, buttons = [] } = {}) {
    const textChunks = splitTelegramText(formatTelegramText(text));
    const payload = {
      chat_id: conversation?.externalConversationId,
      message_id: Number(messageId),
      text: textChunks[0]
    };

    if (buttons.length > 0 && textChunks.length === 1) {
      payload.reply_markup = {
        inline_keyboard: [
          buttons.map((button) => ({
            text: button.text,
            callback_data: `remotecodex:${button.action || button.id || 'action'}:${button.approvalId || ''}`
          }))
        ]
      };
    }

    await this.callApi('editMessageText', payload);

    for (let index = 1; index < textChunks.length; index += 1) {
      await this.sendMessage({
        conversation,
        text: textChunks[index],
        buttons: index === textChunks.length - 1 ? buttons : []
      });
    }

    return { messageId: String(messageId || '') };
  }

  async answerCallback({ callbackQueryId, text = '' } = {}) {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    });
    return { ok: true };
  }
}

export default TelegramChannelProvider;
