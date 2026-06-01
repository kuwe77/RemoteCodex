const state = {
  health: null,
  runtimes: [],
  channels: [],
  sessions: []
};

const $ = (selector) => document.querySelector(selector);

async function getJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

function formatTime(value) {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function text(value, fallback = '-') {
  return String(value || fallback);
}

function setStatus(ok, detail) {
  $('#health-status').textContent = ok ? 'Online' : 'Needs attention';
  $('#health-detail').textContent = detail;
  document.body.dataset.status = ok ? 'online' : 'offline';
}

function renderRuntime() {
  const codex = state.runtimes.find((item) => item.id === 'codex') || state.runtimes[0];
  $('#runtime-provider').textContent = codex?.id ? 'Codex' : 'Not registered';
  $('#runtime-detail').textContent = codex?.capabilities
    ? 'Codex CLI runtime is the only active agent provider.'
    : 'Runtime registry did not return Codex yet.';
}

function renderChannel() {
  const telegram = state.channels.find((item) => item.providerId === 'telegram' || item.id === 'telegram');
  const mode = telegram?.status?.mode || telegram?.capabilities?.mode || 'polling';
  const running = telegram?.status?.running ?? telegram?.running ?? false;
  const enabled = telegram?.status?.enabled === true;
  $('#channel-status').textContent = telegram && enabled ? (running ? 'Running' : 'Configured') : 'Not configured';
  $('#channel-detail').textContent = telegram
    ? `Telegram ${mode}. ${enabled ? (telegram.status?.lastError ? `Last error: ${telegram.status.lastError}` : 'No channel error reported.') : 'Add a bot token to enable polling.'}`
    : 'Add a Telegram bot token with scripts/configure-telegram.cmd.';
}

function renderSessions() {
  $('#session-count').textContent = state.sessions.length;
  const container = $('#sessions');
  if (!state.sessions.length) {
    container.className = 'session-list empty';
    container.textContent = 'No Codex sessions found yet. Send a Telegram message to start one.';
    return;
  }

  container.className = 'session-list';
  container.innerHTML = state.sessions.slice(0, 8).map((session) => {
    const title = text(session.title || session.summary || session.input, 'Untitled session');
    const cwd = text(session.cwd, 'No workspace recorded');
    const status = text(session.status, 'unknown');
    return `
      <article class="session-row">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(cwd)}</span>
        </div>
        <div class="session-meta">
          <span class="chip">${escapeHtml(status)}</span>
          <small>${escapeHtml(formatTime(session.updatedAt || session.createdAt))}</small>
        </div>
      </article>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}

async function refreshDashboard() {
  $('#last-updated').textContent = 'Refreshing...';
  try {
    const [health, runtimes, channels, sessions] = await Promise.all([
      getJson('/health'),
      getJson('/api/agent-runtimes/providers'),
      getJson('/api/agent-channels/providers'),
      getJson('/api/agent-runtimes/sessions?limit=20')
    ]);

    state.health = health;
    state.runtimes = runtimes.providers || [];
    state.channels = channels.providers || [];
    state.sessions = sessions.sessions || [];

    setStatus(true, `Listening on ${location.host}`);
    renderRuntime();
    renderChannel();
    renderSessions();
    $('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    setStatus(false, error.message);
    $('#last-updated').textContent = 'Refresh failed';
  }
}

$('#refresh-button').addEventListener('click', refreshDashboard);
refreshDashboard();
setInterval(refreshDashboard, 30000);
