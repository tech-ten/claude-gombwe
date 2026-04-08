const API = '';
let ws;

// ========== STATE ==========
let activeSessionKey = `web:${Date.now()}`;
let activeTaskId = null;
let chatFilter = 'all';
const chatConversations = new Map();  // Chat sessions only
const taskCache = new Map();          // Tasks only

// ========== WEBSOCKET ==========
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const dot = document.getElementById('statusDot');
    if (dot) dot.classList.remove('offline', 'warning');
  };
  ws.onclose = () => {
    const dot = document.getElementById('statusDot');
    if (dot) dot.classList.add('offline');
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (e) => handleWSEvent(JSON.parse(e.data));
}

function handleWSEvent(event) {
  const d = event.data;
  switch (event.type) {
    case 'task:created':
      taskCache.set(d.id, d);
      renderTaskSidebar();
      break;
    case 'task:started':
      if (taskCache.has(d.id)) { taskCache.set(d.id, d); renderTaskSidebar(); }
      break;
    case 'task:output':
      if (d.taskId === activeTaskId) appendTaskOutput(d.text);
      break;
    case 'task:completed':
    case 'task:failed':
      taskCache.set(d.id, d);
      renderTaskSidebar();
      if (d.id === activeTaskId) renderTaskThread(d.id);
      break;
    case 'session:message': {
      // Create conversation if it doesn't exist (message from Discord/Telegram)
      const msgConv = getOrCreateChat(d.sessionKey, d.message);
      msgConv.messages.push({ role: 'assistant', text: d.message, time: new Date().toISOString() });
      if (d.channel && d.channel !== 'web') msgConv.channel = d.channel;
      renderChatSidebar();
      if (d.sessionKey === activeSessionKey) addChatMsg('assistant', d.message);
      break;
    }
  }
}

// ========== CHAT TAB ==========
function getOrCreateChat(key, firstMsg) {
  if (!chatConversations.has(key)) {
    chatConversations.set(key, {
      key,
      title: firstMsg ? firstMsg.slice(0, 50) : key,
      channel: key.split(':')[0] || 'web',
      messages: [],
      createdAt: new Date().toISOString(),
    });
  }
  return chatConversations.get(key);
}

function renderChatSidebar() {
  const list = document.getElementById('sidebarList');
  list.innerHTML = '';
  const sorted = Array.from(chatConversations.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  for (const conv of sorted) {
    if (chatFilter !== 'all' && conv.channel !== chatFilter) continue;
    const div = document.createElement('div');
    div.className = `sidebar-item${conv.key === activeSessionKey ? ' active' : ''}`;
    div.onclick = () => openChat(conv.key);
    div.innerHTML = `
      <div class="si-title">${esc(conv.title)}</div>
      <div class="si-meta">
        <span>${timeAgo(conv.createdAt)}</span>
        <span class="si-badge chat">${conv.channel}</span>
      </div>
    `;
    list.appendChild(div);
  }
}

function openChat(key) {
  activeSessionKey = key;
  renderChatSidebar();
  renderChatThread();
}

function renderChatThread() {
  const conv = chatConversations.get(activeSessionKey);
  const container = document.getElementById('chatMessages');
  container.innerHTML = '';

  if (!conv || conv.messages.length === 0) {
    container.innerHTML = `<div class="system-msg">
      Type normally to chat (Claude remembers the conversation).<br>
      Start with <strong>task:</strong> or <strong>build:</strong> for autonomous tasks.<br>
      Type <strong>/help</strong> for all commands.
    </div>`;
    document.getElementById('threadTitle').textContent = 'New conversation';
    document.getElementById('threadMeta').textContent = 'chat mode';
    return;
  }

  document.getElementById('threadTitle').textContent = conv.title;
  document.getElementById('threadMeta').textContent = `${conv.channel} · chat mode · ${conv.key}`;

  for (const msg of conv.messages) {
    if (!msg.text) continue;
    const div = document.createElement('div');
    div.className = `msg ${msg.role}`;
    div.innerHTML = `${esc(msg.text)}${msg.time ? `<div class="msg-time">${formatTime(msg.time)}</div>` : ''}`;
    container.appendChild(div);
  }
  container.scrollTop = container.scrollHeight;
}

function addChatMsg(role, text) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `${esc(text)}<div class="msg-time">${formatTime(new Date().toISOString())}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

document.getElementById('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const conv = getOrCreateChat(activeSessionKey, text);
  conv.messages.push({ role: 'user', text, time: new Date().toISOString() });
  if (conv.title === conv.key) conv.title = text.slice(0, 50);

  addChatMsg('user', text);
  input.value = '';
  renderChatSidebar();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', text, sessionKey: activeSessionKey }));
  }
});

document.getElementById('newChatBtn').onclick = () => {
  activeSessionKey = `web:${Date.now()}`;
  renderChatSidebar();
  renderChatThread();
  document.getElementById('chatInput').focus();
};

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chatFilter = btn.dataset.filter;
    renderChatSidebar();
  });
});

// ========== TASKS TAB ==========
async function loadTasks() {
  try {
    const filter = document.getElementById('taskFilter').value;
    const url = filter ? `${API}/api/tasks?status=${filter}` : `${API}/api/tasks`;
    const res = await fetch(url);
    const tasks = await res.json();
    taskCache.clear();
    for (const t of tasks) taskCache.set(t.id, t);
    renderTaskSidebar();
  } catch {}
}

function renderTaskSidebar() {
  const list = document.getElementById('taskSidebarList');
  if (!list) return;
  list.innerHTML = '';

  const filter = document.getElementById('taskFilter')?.value || '';
  const sorted = Array.from(taskCache.values())
    .filter(t => !filter || t.status === filter)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  for (const task of sorted) {
    const div = document.createElement('div');
    div.className = `sidebar-item${task.id === activeTaskId ? ' active' : ''}`;
    div.onclick = () => openTask(task.id);
    div.innerHTML = `
      <div class="si-title">${esc(task.prompt.slice(0, 60))}</div>
      <div class="si-meta">
        <span>${timeAgo(task.createdAt)}</span>
        <span class="si-badge ${task.status}">${task.status}</span>
      </div>
    `;
    list.appendChild(div);
  }
}

function openTask(id) {
  activeTaskId = id;
  renderTaskSidebar();
  renderTaskThread(id);
}

function renderTaskThread(id) {
  const task = taskCache.get(id);
  const container = document.getElementById('taskMessages');
  container.innerHTML = '';

  if (!task) {
    container.innerHTML = '<div class="system-msg">Select a task from the sidebar.</div>';
    return;
  }

  document.getElementById('taskThreadTitle').textContent = task.prompt.slice(0, 80);
  const meta = [`${task.status}`, task.channel, timeAgo(task.createdAt)];
  if (task.attempt > 1) meta.push(`attempt ${task.attempt}/${task.maxAttempts}`);
  document.getElementById('taskThreadMeta').textContent = meta.join(' · ');

  // Show the prompt as user message
  addTaskMsg(container, 'user', task.prompt, task.createdAt);

  // Show output as assistant messages
  const output = (task.output || []).filter(l => !l.startsWith('[stderr]'));
  const gombweLines = output.filter(l => l.startsWith('[gombwe]'));
  const contentLines = output.filter(l => !l.startsWith('[gombwe]'));

  // Show gombwe status lines
  for (const line of gombweLines) {
    addTaskMsg(container, 'status', line.replace('[gombwe] ', ''));
  }

  // Show actual content
  if (contentLines.length > 0) {
    addTaskMsg(container, 'assistant', contentLines.join('\n'), task.completedAt || task.startedAt);
  }

  if (task.error) {
    addTaskMsg(container, 'status', `Error: ${task.error}`);
  }

  container.scrollTop = container.scrollHeight;
}

function addTaskMsg(container, role, text, time) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `${esc(text)}${time ? `<div class="msg-time">${formatTime(time)}</div>` : ''}`;
  container.appendChild(div);
}

function appendTaskOutput(text) {
  if (text.startsWith('[stderr]') || text.startsWith('[gombwe]')) return;
  const container = document.getElementById('taskMessages');
  let live = document.getElementById('task-live-output');
  if (!live) {
    live = document.createElement('div');
    live.id = 'task-live-output';
    live.className = 'msg assistant';
    container.appendChild(live);
  }
  live.textContent += text + '\n';
  container.scrollTop = container.scrollHeight;
}

document.getElementById('taskFilter').onchange = loadTasks;

document.getElementById('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('taskInput');
  const text = input.value.trim();
  if (!text) return;

  const task = taskCache.get(activeTaskId);
  const sessionKey = task ? task.sessionKey : `task:${Date.now()}`;

  await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: text, channel: 'web', sessionKey }),
  });
  input.value = '';
  loadTasks();
});

// ========== SKILLS ==========
let cachedSkills = [];

async function refreshSkills() {
  const res = await fetch(`${API}/api/skills`);
  cachedSkills = await res.json();
  const container = document.getElementById('skillList');
  container.innerHTML = '';

  for (const skill of cachedSkills) {
    const hasTtools = skill.tools && skill.tools.length > 0;
    const toolBadge = hasTtools ? ` <span class="si-badge completed">${skill.tools.length} tools</span>` : '';
    const div = document.createElement('div');
    div.className = 'skill-item';
    div.innerHTML = `
      <div class="skill-header">
        <div class="skill-name">/${skill.name}${toolBadge}</div>
        <div class="skill-actions">
          <button onclick="runSkill('${skill.name}')">Run Now</button>
          <button onclick="scheduleSkill('${skill.name}')" class="btn-secondary">Schedule</button>
        </div>
      </div>
      <div class="skill-desc">${esc(skill.description)}</div>
    `;
    container.appendChild(div);
  }

  const select = document.getElementById('jobSkillSelect');
  if (select) {
    select.innerHTML = '<option value="">Or pick a skill...</option>';
    for (const skill of cachedSkills) {
      const opt = document.createElement('option');
      opt.value = `/${skill.name}`;
      opt.textContent = `/${skill.name} — ${skill.description}`;
      select.appendChild(opt);
    }
  }
}

function runSkill(name) {
  switchTab('chat');
  document.getElementById('chatInput').value = `/${name}`;
  document.getElementById('chatForm').dispatchEvent(new Event('submit'));
}

function scheduleSkill(name) {
  switchTab('jobs');
  document.getElementById('jobForm').classList.remove('hidden');
  document.getElementById('jobPrompt').value = `/${name}`;
}

document.getElementById('reloadSkills').onclick = async () => {
  await fetch(`${API}/api/skills/reload`, { method: 'POST' });
  refreshSkills();
};

// ========== JOBS ==========
async function refreshJobs() {
  const res = await fetch(`${API}/api/cron`);
  const jobs = await res.json();
  const container = document.getElementById('jobList');
  container.innerHTML = '';

  if (jobs.length === 0) {
    container.innerHTML = '<div class="system-msg">No scheduled jobs. Click "+ New Job" to create one.</div>';
    return;
  }

  for (const job of jobs) {
    const div = document.createElement('div');
    div.className = 'cron-item';
    div.innerHTML = `
      <div>
        <div class="cron-expr">${esc(job.expression)} <span style="color:var(--ink-faint);font-size:11px">${cronToHuman(job.expression)}</span></div>
        <div class="cron-prompt">${esc(job.prompt.slice(0, 100))}</div>
        ${job.nextRun ? `<div style="font-size:10px;color:var(--ink-faint);margin-top:2px">Next: ${new Date(job.nextRun).toLocaleString()}</div>` : ''}
      </div>
      <div class="cron-actions">
        <button onclick="toggleJob('${job.id}', ${!job.enabled})">${job.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn-danger" onclick="deleteJob('${job.id}')">Delete</button>
      </div>
    `;
    container.appendChild(div);
  }
}

document.getElementById('addJobBtn').onclick = () => document.getElementById('jobForm').classList.toggle('hidden');
document.getElementById('cancelJob').onclick = () => document.getElementById('jobForm').classList.add('hidden');
document.getElementById('jobSchedulePreset').onchange = (e) => { if (e.target.value) document.getElementById('jobCronExpr').value = e.target.value; };
document.getElementById('jobSkillSelect').onchange = (e) => { if (e.target.value) document.getElementById('jobPrompt').value = e.target.value; };

document.getElementById('saveJob').onclick = async () => {
  const expression = document.getElementById('jobCronExpr').value.trim();
  const prompt = document.getElementById('jobPrompt').value.trim();
  if (!expression || !prompt) return alert('Both schedule and prompt are required.');
  await fetch(`${API}/api/cron`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression, prompt }),
  });
  document.getElementById('jobCronExpr').value = '';
  document.getElementById('jobPrompt').value = '';
  document.getElementById('jobForm').classList.add('hidden');
  refreshJobs();
};

async function toggleJob(id, enabled) {
  await fetch(`${API}/api/cron/${id}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  refreshJobs();
}

async function deleteJob(id) {
  if (!confirm('Delete this job?')) return;
  await fetch(`${API}/api/cron/${id}`, { method: 'DELETE' });
  refreshJobs();
}

// ========== SERVICES ==========
const ALL_SERVICES = {
  github: { name: 'GitHub', desc: 'Issues, PRs, repos, code search' },
  gmail: { name: 'Gmail', desc: 'Read, search, and manage email' },
  'google-calendar': { name: 'Google Calendar', desc: 'Read and manage calendar events' },
  slack: { name: 'Slack', desc: 'Read/send messages, search channels' },
  'brave-search': { name: 'Web Search', desc: 'Search the web for current information' },
  filesystem: { name: 'Filesystem', desc: 'Read and manage local files' },
  fetch: { name: 'HTTP Fetch', desc: 'Fetch URLs, scrape web pages' },
  memory: { name: 'Memory', desc: 'Persistent knowledge graph' },
};

function refreshServices() {
  const container = document.getElementById('serviceList');
  container.innerHTML = '';
  for (const [id, svc] of Object.entries(ALL_SERVICES)) {
    const div = document.createElement('div');
    div.className = 'service-item';
    div.innerHTML = `
      <div class="service-info">
        <div class="service-name">${svc.name}</div>
        <div class="service-desc">${svc.desc}</div>
      </div>
      <code style="font-size:10px;color:var(--ink-faint)">gombwe connect ${id}</code>
    `;
    container.appendChild(div);
  }
}

// ========== STATUS ==========
async function refreshStatus() {
  try {
    const res = await fetch(`${API}/api/status`);
    const s = await res.json();
    document.getElementById('headerStats').innerHTML = `
      <span>${s.tasks.running} running</span>
      <span>${s.tasks.total} tasks</span>
      <span>${s.skills} skills</span>
    `;
  } catch {
    document.getElementById('headerStats').textContent = 'Disconnected';
  }
}

// ========== NAVIGATION ==========
function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-item[data-tab="${name}"]`)?.classList.add('active');
  document.getElementById(`tab-${name}`)?.classList.add('active');
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    switch (btn.dataset.tab) {
      case 'tasks': loadTasks(); break;
      case 'skills': refreshSkills(); break;
      case 'jobs': refreshJobs(); break;
      case 'services': refreshServices(); break;
      case 'family': loadFamily(); break;
    }
  });
});

// ========== HELPERS ==========
function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function formatTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function cronToHuman(expr) {
  const p = expr.split(' ');
  if (p.length !== 5) return '';
  const [min, hr, , , dow] = p;
  if (min.startsWith('*/')) return `(every ${min.slice(2)} min)`;
  if (hr === '*') return `(hourly :${min.padStart(2,'0')})`;
  const t = `${hr.padStart(2,'0')}:${min.padStart(2,'0')}`;
  if (dow === '*') return `(daily ${t})`;
  if (dow === '1-5') return `(weekdays ${t})`;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (dow !== '*') return `(${days[+dow]||dow} ${t})`;
  return '';
}

// ========== AUTOCOMPLETE ==========
const BUILTIN_COMMANDS = [
  { cmd: '/help', desc: 'Show all commands', type: 'cmd' },
  { cmd: '/new', desc: 'Start a fresh conversation', type: 'cmd' },
  { cmd: '/tasks', desc: 'List recent tasks', type: 'cmd' },
  { cmd: '/queue', desc: 'List recent tasks (alias)', type: 'cmd' },
  { cmd: '/sessions', desc: 'List active conversations', type: 'cmd' },
  { cmd: '/skills', desc: 'List available skills', type: 'cmd' },
  { cmd: '/model', desc: 'Switch model (opus/sonnet/haiku)', type: 'cmd' },
  { cmd: '/mode', desc: 'Switch mode (chat/task)', type: 'cmd' },
  { cmd: '/cancel', desc: 'Cancel a running task', type: 'cmd' },
  { cmd: '/set', desc: 'Configure gombwe (discord.token, telegram.token, model)', type: 'cmd' },
  { cmd: '/task', desc: 'Run as autonomous task', type: 'action' },
  { cmd: '/build', desc: 'Build something autonomously', type: 'action' },
  { cmd: '/fix', desc: 'Fix a bug autonomously', type: 'action' },
  { cmd: '/deploy', desc: 'Deploy check and deploy', type: 'action' },
  { cmd: '/refactor', desc: 'Refactor code autonomously', type: 'action' },
  { cmd: '/test', desc: 'Run or write tests', type: 'action' },
  { cmd: '/create', desc: 'Create something new', type: 'action' },
];

let acSelectedIndex = -1;

function getAllCommands() {
  const skillCmds = cachedSkills.map(s => ({
    cmd: `/${s.name}`,
    desc: s.description,
    type: 'skill',
  }));
  return [...BUILTIN_COMMANDS, ...skillCmds];
}

function showAutocomplete(filter) {
  const list = document.getElementById('autocompleteList');
  const all = getAllCommands();
  const query = filter.toLowerCase();
  const matches = all.filter(c => c.cmd.toLowerCase().includes(query));

  if (matches.length === 0) {
    list.classList.add('hidden');
    return;
  }

  list.classList.remove('hidden');
  list.innerHTML = '';
  acSelectedIndex = -1;

  for (let i = 0; i < matches.length; i++) {
    const item = matches[i];
    const div = document.createElement('div');
    div.className = 'autocomplete-item';
    div.innerHTML = `
      <span class="ac-cmd">${esc(item.cmd)}</span>
      <span>
        <span class="ac-desc">${esc(item.desc)}</span>
        <span class="ac-type ${item.type}">${item.type}</span>
      </span>
    `;
    div.onclick = () => selectAutocomplete(item.cmd);
    list.appendChild(div);
  }
}

function hideAutocomplete() {
  document.getElementById('autocompleteList').classList.add('hidden');
  acSelectedIndex = -1;
}

function selectAutocomplete(cmd) {
  const input = document.getElementById('chatInput');
  input.value = cmd + ' ';
  input.focus();
  hideAutocomplete();
}

// Wire up input events
document.getElementById('chatInput').addEventListener('input', (e) => {
  const val = e.target.value;
  if (val.startsWith('/')) {
    showAutocomplete(val);
  } else {
    hideAutocomplete();
  }
});

document.getElementById('chatInput').addEventListener('keydown', (e) => {
  const list = document.getElementById('autocompleteList');
  if (list.classList.contains('hidden')) return;

  const items = list.querySelectorAll('.autocomplete-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acSelectedIndex = Math.min(acSelectedIndex + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === acSelectedIndex));
    items[acSelectedIndex]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acSelectedIndex = Math.max(acSelectedIndex - 1, 0);
    items.forEach((el, i) => el.classList.toggle('selected', i === acSelectedIndex));
    items[acSelectedIndex]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Tab' || (e.key === 'Enter' && acSelectedIndex >= 0)) {
    e.preventDefault();
    const selected = items[acSelectedIndex];
    if (selected) {
      const cmd = selected.querySelector('.ac-cmd').textContent;
      selectAutocomplete(cmd);
    }
  } else if (e.key === 'Escape') {
    hideAutocomplete();
  }
});

// Hide autocomplete when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.autocomplete-container')) hideAutocomplete();
});

// Load skills for autocomplete on startup
async function loadSkillsForAutocomplete() {
  try {
    const res = await fetch(`${API}/api/skills`);
    cachedSkills = await res.json();
  } catch {}
}

// ========== LOAD ALL SESSIONS (web, discord, telegram, etc.) ==========
async function loadAllSessions() {
  try {
    const res = await fetch(`${API}/api/sessions`);
    const sessions = await res.json();
    for (const s of sessions) {
      if (!chatConversations.has(s.key)) {
        const channel = s.key.split(':')[0] || 'web';
        chatConversations.set(s.key, {
          key: s.key,
          title: s.key,
          channel,
          messages: [],
          createdAt: s.createdAt || new Date().toISOString(),
        });
      }
      const conv = chatConversations.get(s.key);
      if (conv && conv.title === conv.key) {
        // Try to load the session to get a better title
        try {
          const detail = await fetch(`${API}/api/sessions/${encodeURIComponent(s.key)}`);
          const full = await detail.json();
          if (full.transcript && full.transcript.length > 0) {
            const firstUser = full.transcript.find(t => t.role === 'user');
            if (firstUser) conv.title = firstUser.content.slice(0, 50);
            // Load messages
            conv.messages = full.transcript.map(t => ({
              role: t.role === 'user' ? 'user' : 'assistant',
              text: t.content,
              time: t.timestamp,
            }));
          }
        } catch {}
      }
    }
    renderChatSidebar();
  } catch {}
}

// ========== COMMAND PALETTE (Cmd+K) ==========
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const overlay = document.getElementById('cmdOverlay');
    overlay.classList.toggle('hidden');
    if (!overlay.classList.contains('hidden')) {
      const input = document.getElementById('cmdInput');
      input.value = '';
      input.focus();
      renderCmdResults('');
    }
  }
  if (e.key === 'Escape') {
    document.getElementById('cmdOverlay').classList.add('hidden');
  }
});

document.getElementById('cmdOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('cmdInput').addEventListener('input', (e) => {
  renderCmdResults(e.target.value);
});

function renderCmdResults(query) {
  const container = document.getElementById('cmdResults');
  const all = getAllCommands();
  const q = query.toLowerCase();
  const matches = q ? all.filter(c => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)) : all;

  container.innerHTML = '';
  for (const item of matches.slice(0, 12)) {
    const div = document.createElement('div');
    div.className = 'autocomplete-item';
    div.innerHTML = `
      <span class="ac-cmd">${esc(item.cmd)}</span>
      <span>
        <span class="ac-desc">${esc(item.desc)}</span>
        <span class="ac-type ${item.type}">${item.type}</span>
      </span>
    `;
    div.onclick = () => {
      document.getElementById('cmdOverlay').classList.add('hidden');
      switchTab('chat');
      document.getElementById('chatInput').value = item.cmd + ' ';
      document.getElementById('chatInput').focus();
    };
    container.appendChild(div);
  }
}

// ========== SIDEBAR TOGGLE ==========
document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('collapsed');
});

// ========== TOP BAR SEARCH ==========
document.getElementById('topbarSearch')?.addEventListener('click', () => {
  document.getElementById('cmdOverlay').classList.remove('hidden');
  const input = document.getElementById('cmdInput');
  input.value = '';
  input.focus();
  renderCmdResults('');
});

// ========== FAMILY ==========
let familyData = { meals: {}, groceryList: [], nonFoodList: [], pantry: [], events: [], members: [], lastOrdered: null };
let weekOffset = 0;

async function loadFamily() {
  try {
    const res = await fetch(`${API}/api/family`);
    familyData = await res.json();
    if (!familyData.pantry) familyData.pantry = [];
    if (!familyData.nonFoodList) familyData.nonFoodList = [];
    if (!familyData.lastOrdered) familyData.lastOrdered = null;
  } catch {}
  await loadRecipes();
  renderAll();
}

function renderAll() {
  renderWeekGrid();
  renderGroceryList();
  renderNonFoodList();
  renderPantryList();
  renderRecipes();
  renderSchoolEvents();
  renderOrderStatus();
  renderActionLog();
}

async function saveFamily() {
  try {
    await fetch(`${API}/api/family`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(familyData)
    });
  } catch {}
}

function getWeekDates() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay() + 1 + weekOffset * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isoWeek(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Action log
function logAction(actor, action, detail) {
  if (!familyData.actions) familyData.actions = [];
  familyData.actions.unshift({
    time: new Date().toISOString(),
    actor, // 'user' or 'gombwe'
    action,
    detail
  });
  // Keep last 100
  if (familyData.actions.length > 100) familyData.actions.length = 100;
}

// Check meal coverage: 'pantry' = fully stocked, 'listed' = on grocery list, 'missing' = neither
function mealStatus(mealName) {
  if (!mealName) return 'none';
  const lower = mealName.toLowerCase();
  const pantryNames = (familyData.pantry || []).map(i => i.toLowerCase());
  const groceryNames = (familyData.groceryList || []).map(i => i.name.toLowerCase());
  // If any grocery item references this meal, it's listed
  const onList = groceryNames.some(item => item.includes(lower) || lower.includes(item)) ||
    (familyData.groceryList || []).some(i => (i.meals || []).includes(lower) || (i.meal === lower));
  const inPantry = pantryNames.some(item => item.includes(lower) || lower.includes(item));
  if (inPantry) return 'pantry';
  if (onList) return 'listed';
  return 'missing';
}

// Extract ingredients for a meal and add to grocery list
async function extractAndAddIngredients(mealName) {
  if (!mealName) return;
  const pantry = familyData.pantry || [];
  const existing = (familyData.groceryList || []).map(i => i.name);
  try {
    const res = await fetch(`${API}/api/family/ingredients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meal: mealName, pantry, existing })
    });
    const data = await res.json();
    if (data.ingredients && data.ingredients.length > 0) {
      const source = data.source === 'local' ? 'gombwe' : 'gombwe (ai)';
      logAction(source, 'ingredients added', `${mealName}: ${data.ingredients.join(', ')}`);
      if (!familyData.groceryList) familyData.groceryList = [];
      for (const item of data.ingredients) {
        const lower = item.toLowerCase();
        // Fuzzy match: "garlic" matches "garlic", "onion" matches "onions", "eggs" matches "free range eggs 12 pack"
        const idx = familyData.groceryList.findIndex(i => {
          const n = i.name.toLowerCase();
          return n === lower || n.includes(lower) || lower.includes(n) ||
            n.replace(/s$/, '') === lower.replace(/s$/, '');
        });
        if (idx >= 0) {
          const existing = familyData.groceryList[idx];
          if (!existing.meals) existing.meals = [];
          if (!existing.meals.includes(mealName.toLowerCase())) existing.meals.push(mealName.toLowerCase());
          existing.source = 'auto';
        } else {
          familyData.groceryList.push({ name: item, checked: false, source: 'auto', meals: [mealName.toLowerCase()] });
        }
      }
      await saveFamily();
      renderGroceryList();
    }
  } catch {}
}

function renderWeekGrid() {
  const grid = document.getElementById('weekGrid');
  if (!grid) return;
  const days = getWeekDates();
  const today = dateKey(new Date());

  const label = document.getElementById('weekLabel');
  if (label) {
    const s = days[0], e = days[6];
    label.textContent = `${s.getDate()} ${MONTHS[s.getMonth()]} — ${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;
  }

  grid.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = days[i];
    const dk = dateKey(d);
    const isToday = dk === today;
    const div = document.createElement('div');
    div.className = `week-day${isToday ? ' today' : ''}`;

    const dayEvents = (familyData.events || []).filter(ev => ev.date === dk);
    const meals = familyData.meals?.[dk] || {};

    // Meal slots — clickable to edit
    let mealsHtml = '';
    for (const slot of ['breakfast', 'lunch', 'dinner']) {
      const name = meals[slot] || '';
      const status = name ? mealStatus(name) : 'none';
      const statusCls = status === 'listed' ? ' on-list' : status === 'missing' ? ' unresolved' : '';
      mealsHtml += `
        <div class="meal-slot${name ? '' : ' empty'}${statusCls}" data-date="${dk}" data-slot="${slot}">
          <span class="meal-slot-label">${slot[0].toUpperCase()}</span>
          <span class="meal-slot-name">${name ? esc(name) : '—'}</span>
        </div>
      `;
    }

    // Events (school, general)
    let eventsHtml = '';
    for (const ev of dayEvents) {
      const cls = ev.type === 'school' ? 'school' : 'general';
      eventsHtml += `<div class="week-event ${cls}" title="${esc(ev.title)}">${esc(ev.title)}</div>`;
    }

    div.innerHTML = `
      <div class="week-day-header">
        <span class="week-day-label">${DAY_NAMES[i]}</span>
        <span class="week-day-num">${d.getDate()}</span>
      </div>
      <div class="week-day-meals">${mealsHtml}</div>
      ${eventsHtml ? `<div class="week-day-events">${eventsHtml}</div>` : ''}
    `;
    grid.appendChild(div);
  }

  // Click to edit meals
  grid.querySelectorAll('.meal-slot').forEach(el => {
    el.addEventListener('click', () => {
      const dk = el.dataset.date;
      const slot = el.dataset.slot;
      const current = familyData.meals?.[dk]?.[slot] || '';
      const val = prompt(`${slot.charAt(0).toUpperCase() + slot.slice(1)} for ${dk}:`, current);
      if (val === null) return;
      if (!familyData.meals) familyData.meals = {};
      if (!familyData.meals[dk]) familyData.meals[dk] = {};
      if (val) {
        familyData.meals[dk][slot] = val;
        logAction('user', 'meal added', `${slot} on ${dk}: ${val}`);
      } else {
        logAction('user', 'meal removed', `${slot} on ${dk}: ${current}`);
        delete familyData.meals[dk][slot];
      }
      saveFamily();
      renderAll();
      if (val) extractAndAddIngredients(val);
    });
  });
}

function renderGroceryList() {
  const list = document.getElementById('groceryList');
  if (!list) return;
  const items = familyData.groceryList || [];

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-list">No items. Add groceries below or plan meals above.</div>';
    return;
  }

  list.innerHTML = '';
  items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = `grocery-item${item.checked ? ' checked' : ''}`;
    let sourceTag = '';
    const mealNames = item.meals || (item.meal ? [item.meal] : []);
    if (item.source === 'human' && mealNames.length > 0) {
      sourceTag = `<span class="grocery-source from-human" title="preference: ${esc(mealNames.join(', '))}">${esc(mealNames.join(', '))}</span>`;
    } else if ((item.source === 'auto' || item.source === 'meal') && mealNames.length > 0) {
      sourceTag = `<span class="grocery-source from-auto" title="${esc(mealNames.join(', '))}">${esc(mealNames.join(', '))}</span>`;
    }
    div.innerHTML = `
      <div class="grocery-check" data-idx="${idx}"></div>
      <span class="grocery-name">${esc(item.name)}${sourceTag}</span>
      <button class="grocery-remove" data-idx="${idx}">remove</button>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('.grocery-check').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      familyData.groceryList[idx].checked = !familyData.groceryList[idx].checked;
      saveFamily();
      renderGroceryList();
    });
  });

  list.querySelectorAll('.grocery-remove').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      familyData.groceryList.splice(idx, 1);
      saveFamily();
      renderGroceryList();
      renderWeekGrid();
      renderWeekGrid();
    });
  });
}

function renderNonFoodList() {
  const list = document.getElementById('nonFoodList');
  if (!list) return;
  const items = familyData.nonFoodList || [];

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-list">Toilet paper, cleaning supplies, etc.</div>';
    return;
  }

  list.innerHTML = '';
  items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = `grocery-item${item.checked ? ' checked' : ''}`;
    div.innerHTML = `
      <div class="grocery-check" data-idx="${idx}" data-list="nonfood"></div>
      <span class="grocery-name">${esc(item.name)}</span>
      <button class="grocery-remove" data-idx="${idx}" data-list="nonfood">remove</button>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('.grocery-check').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      familyData.nonFoodList[idx].checked = !familyData.nonFoodList[idx].checked;
      saveFamily();
      renderNonFoodList();
    });
  });

  list.querySelectorAll('.grocery-remove').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      familyData.nonFoodList.splice(idx, 1);
      saveFamily();
      renderNonFoodList();
    });
  });
}

function renderPantryList() {
  const list = document.getElementById('pantryList');
  if (!list) return;
  const items = familyData.pantry || [];

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-list">Items you already have at home. Meals covered by pantry won\'t show red.</div>';
    return;
  }

  list.innerHTML = '';
  items.forEach((name, idx) => {
    const div = document.createElement('div');
    div.className = 'pantry-item';
    div.innerHTML = `
      <span>${esc(name)}</span>
      <button class="pantry-remove" data-idx="${idx}">remove</button>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('.pantry-remove').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      familyData.pantry.splice(idx, 1);
      saveFamily();
      renderPantryList();
      renderWeekGrid();
      renderWeekGrid();
    });
  });
}

function renderOrderStatus() {
  const el = document.getElementById('orderStatus');
  if (!el) return;
  if (familyData.lastOrdered) {
    const d = new Date(familyData.lastOrdered);
    const now = new Date();
    // Same ISO week = already ordered this week
    if (isoWeek(d) === isoWeek(now) && d.getFullYear() === now.getFullYear()) {
      el.textContent = `Ordered ${DAY_NAMES[(d.getDay()+6)%7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    } else {
      el.textContent = '';
    }
  }
}

// Add grocery items
document.getElementById('groceryAddForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('groceryInput');
  const val = input.value.trim();
  if (!val) return;
  if (!familyData.groceryList) familyData.groceryList = [];
  const items = val.split(',').map(s => s.trim()).filter(Boolean);
  items.forEach(name => {
    familyData.groceryList.push({ name, checked: false });
  });
  logAction('user', 'grocery added', items.join(', '));
  saveFamily();
  renderAll();
  input.value = '';
});

// Add non-food items
document.getElementById('nonFoodAddForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('nonFoodInput');
  const val = input.value.trim();
  if (!val) return;
  if (!familyData.nonFoodList) familyData.nonFoodList = [];
  val.split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
    familyData.nonFoodList.push({ name, checked: false });
  });
  saveFamily();
  renderNonFoodList();
  input.value = '';
});

// Add pantry items
document.getElementById('pantryAddForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('pantryInput');
  const val = input.value.trim();
  if (!val) return;
  if (!familyData.pantry) familyData.pantry = [];
  val.split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
    if (!familyData.pantry.includes(name)) familyData.pantry.push(name);
  });
  saveFamily();
  renderPantryList();
  renderWeekGrid();
  input.value = '';
});

// Order Now — sends to chat AND marks this week as ordered (skips cron job)
document.getElementById('orderGroceriesBtn')?.addEventListener('click', async () => {
  const groceries = (familyData.groceryList || []).filter(i => !i.checked).map(i => i.name);
  const nonFood = (familyData.nonFoodList || []).filter(i => !i.checked).map(i => i.name);
  const all = [...groceries, ...nonFood];
  if (all.length === 0) { alert('No items to order.'); return; }

  const summary = `Groceries (${groceries.length}):\n${groceries.join(', ')}\n\nHousehold (${nonFood.length}):\n${nonFood.join(', ')}`;
  if (!confirm(`Order ${all.length} items via Gombwe?\n\n${summary}`)) return;

  // Log and move ordered items to pantry
  logAction('user', 'order placed', `${all.length} items (${groceries.length} grocery, ${nonFood.length} household)`);
  if (!familyData.pantry) familyData.pantry = [];
  for (const name of groceries) {
    if (!familyData.pantry.some(p => p.toLowerCase() === name.toLowerCase())) {
      familyData.pantry.push(name);
    }
  }
  familyData.groceryList = [];
  familyData.nonFoodList = [];
  familyData.lastOrdered = new Date().toISOString();
  saveFamily();
  renderAll();

  // Send to chat
  switchTab('chat');
  const input = document.getElementById('chatInput');
  input.value = `/grocery-order ${all.join(', ')}`;
  document.getElementById('chatForm').dispatchEvent(new Event('submit'));
});

function renderSchoolEvents() {
  const list = document.getElementById('schoolEvents');
  if (!list) return;
  const events = (familyData.events || []).filter(e => e.type === 'school')
    .sort((a, b) => a.date.localeCompare(b.date));

  if (events.length === 0) {
    list.innerHTML = '<div class="empty-list">No school events. Click Add Event above.</div>';
    return;
  }

  list.innerHTML = '';
  events.forEach((ev, idx) => {
    const div = document.createElement('div');
    div.className = 'school-event';
    const d = new Date(ev.date + 'T00:00:00');
    div.innerHTML = `
      <div class="school-event-info">
        <div class="school-event-title">${esc(ev.title)}</div>
        <div class="school-event-meta">${ev.child ? esc(ev.child) : ''} ${ev.notes ? '— ' + esc(ev.notes) : ''}</div>
      </div>
      <div class="school-event-date">${DAY_NAMES[(d.getDay()+6)%7]} ${d.getDate()} ${MONTHS[d.getMonth()]}</div>
    `;
    list.appendChild(div);
  });
}

document.getElementById('addSchoolEventBtn')?.addEventListener('click', () => {
  const title = prompt('Event name (e.g. "School photos", "Sports day"):');
  if (!title) return;
  const date = prompt('Date (YYYY-MM-DD):', dateKey(new Date()));
  if (!date) return;
  const child = prompt('Child name (optional):');
  if (!familyData.events) familyData.events = [];
  familyData.events.push({ title, date, type: 'school', child: child || '', notes: '' });
  logAction('user', 'school event added', `${title} on ${date}${child ? ' (' + child + ')' : ''}`);
  saveFamily();
  renderSchoolEvents();
  renderWeekGrid();
});

function renderActionLog() {
  const list = document.getElementById('actionLog');
  if (!list) return;
  const actions = familyData.actions || [];

  if (actions.length === 0) {
    list.innerHTML = '<div class="empty-list">No actions yet.</div>';
    return;
  }

  list.innerHTML = '';
  for (const a of actions.slice(0, 20)) {
    const div = document.createElement('div');
    div.className = 'action-item';
    const isAi = a.actor.includes('gombwe');
    div.innerHTML = `
      <div class="action-actor ${isAi ? 'ai' : 'human'}">${esc(a.actor)}</div>
      <div class="action-body">
        <span class="action-type">${esc(a.action)}</span>
        <span class="action-detail">${esc(a.detail)}</span>
      </div>
      <div class="action-time">${timeAgo(a.time)}</div>
    `;
    list.appendChild(div);
  }
}

document.getElementById('weekPrev')?.addEventListener('click', () => { weekOffset--; renderWeekGrid(); });
document.getElementById('weekNext')?.addEventListener('click', () => { weekOffset++; renderWeekGrid(); });

// ========== RECIPES ==========
let recipesData = {};
let expandedRecipes = new Set();

async function loadRecipes() {
  try {
    const res = await fetch(`${API}/api/family/recipes`);
    recipesData = await res.json();
  } catch {}
  renderRecipes();
}

async function saveRecipe(name, data) {
  try {
    await fetch(`${API}/api/family/recipes/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch {}
}

function renderRecipes() {
  const container = document.getElementById('recipeList');
  if (!container) return;
  const names = Object.keys(recipesData).sort();

  if (names.length === 0) {
    container.innerHTML = '<div class="card"><div class="empty-list">No recipes yet. Add meals to the planner and ingredients will be extracted automatically.</div></div>';
    return;
  }

  container.innerHTML = '';
  for (const name of names) {
    const recipe = recipesData[name];
    const expanded = expandedRecipes.has(name);
    const ingredients = recipe.ingredients || [];
    const prefs = recipe.preferences || {};

    const card = document.createElement('div');
    card.className = 'recipe-card';

    let ingredientsHtml = '';
    ingredients.forEach((ing, idx) => {
      const isHuman = prefs[ing] === 'human';
      const tag = isHuman
        ? '<span class="recipe-ingredient-tag human">preference</span>'
        : '<span class="recipe-ingredient-tag auto">auto</span>';
      ingredientsHtml += `
        <div class="recipe-ingredient">
          <span class="recipe-ingredient-name" data-recipe="${esc(name)}" data-idx="${idx}">${esc(ing)}</span>
          ${tag}
          <button class="recipe-ingredient-remove" data-recipe="${esc(name)}" data-idx="${idx}">remove</button>
        </div>
      `;
    });

    card.innerHTML = `
      <div class="recipe-header" data-recipe="${esc(name)}">
        <span class="recipe-name">${esc(name)}</span>
        <span class="recipe-count">${ingredients.length} ingredients</span>
      </div>
      <div class="recipe-body${expanded ? '' : ' collapsed'}">
        ${ingredientsHtml}
        <form class="recipe-add-form" data-recipe="${esc(name)}">
          <input type="text" placeholder="Add ingredient..." data-recipe="${esc(name)}">
          <button type="submit" class="btn-primary btn-sm">Add</button>
        </form>
        ${recipe.recipe ? `<div class="recipe-instructions">${esc(recipe.recipe)}</div>` : ''}
      </div>
    `;
    container.appendChild(card);
  }

  // Toggle expand/collapse
  container.querySelectorAll('.recipe-header').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.recipe;
      if (expandedRecipes.has(name)) expandedRecipes.delete(name);
      else expandedRecipes.add(name);
      renderRecipes();
    });
  });

  // Click ingredient to edit
  container.querySelectorAll('.recipe-ingredient-name').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = el.dataset.recipe;
      const idx = parseInt(el.dataset.idx);
      const recipe = recipesData[name];
      const current = recipe.ingredients[idx];
      const val = prompt(`Edit ingredient for ${name}:`, current);
      if (val === null || val === current) return;
      if (!val) return; // don't allow blank — use remove instead
      const old = recipe.ingredients[idx];
      recipe.ingredients[idx] = val;
      if (!recipe.preferences) recipe.preferences = {};
      // Remove old preference key, mark new one as human
      delete recipe.preferences[old];
      recipe.preferences[val] = 'human';
      logAction('user', 'ingredient edited', `${name}: "${old}" → "${val}"`);
      saveRecipe(name, recipe);
      saveFamily();
      renderRecipes();
      // Update grocery list if the old ingredient was on it for this meal
      updateGroceryForRecipeChange(name, old, val);
    });
  });

  // Remove ingredient
  container.querySelectorAll('.recipe-ingredient-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = el.dataset.recipe;
      const idx = parseInt(el.dataset.idx);
      const recipe = recipesData[name];
      const removed = recipe.ingredients.splice(idx, 1)[0];
      if (recipe.preferences) delete recipe.preferences[removed];
      logAction('user', 'ingredient removed', `${name}: "${removed}"`);
      saveRecipe(name, recipe);
      saveFamily();
      renderRecipes();
      // Remove from grocery list if only used by this meal
      removeGroceryIfOrphan(removed, name);
    });
  });

  // Add ingredient
  container.querySelectorAll('.recipe-add-form').forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.dataset.recipe;
      const input = form.querySelector('input');
      const val = input.value.trim();
      if (!val) return;
      const recipe = recipesData[name];
      recipe.ingredients.push(val);
      if (!recipe.preferences) recipe.preferences = {};
      recipe.preferences[val] = 'human';
      logAction('user', 'ingredient added', `${name}: "${val}"`);
      saveRecipe(name, recipe);
      saveFamily();
      input.value = '';
      renderRecipes();
      // Add to grocery list for this meal
      addGroceryFromRecipe(name, val);
    });
  });
}

// When a recipe ingredient is edited, update the grocery list
function updateGroceryForRecipeChange(mealName, oldIng, newIng) {
  const lower = mealName.toLowerCase();
  const oldLower = oldIng.toLowerCase();
  const list = familyData.groceryList || [];
  const idx = list.findIndex(i => {
    const n = i.name.toLowerCase();
    return (n === oldLower || n.includes(oldLower) || oldLower.includes(n)) &&
      (i.meals || []).includes(lower);
  });
  if (idx >= 0) {
    list[idx].name = newIng;
    list[idx].source = 'human';
    saveFamily();
    renderGroceryList();
  }
}

// When a recipe ingredient is removed, remove from grocery if no other meal uses it
function removeGroceryIfOrphan(ingredient, mealName) {
  const lower = ingredient.toLowerCase();
  const mealLower = mealName.toLowerCase();
  const list = familyData.groceryList || [];
  const idx = list.findIndex(i => {
    const n = i.name.toLowerCase();
    return n === lower || n.includes(lower) || lower.includes(n);
  });
  if (idx >= 0) {
    const item = list[idx];
    if (item.meals) {
      item.meals = item.meals.filter(m => m !== mealLower);
      if (item.meals.length === 0 && item.source === 'auto') {
        list.splice(idx, 1);
      }
    }
    saveFamily();
    renderGroceryList();
  }
}

// When a human adds an ingredient to a recipe, add it to grocery list
function addGroceryFromRecipe(mealName, ingredient) {
  if (!familyData.groceryList) familyData.groceryList = [];
  const lower = ingredient.toLowerCase();
  const mealLower = mealName.toLowerCase();
  const idx = familyData.groceryList.findIndex(i => {
    const n = i.name.toLowerCase();
    return n === lower || n.includes(lower) || lower.includes(n) ||
      n.replace(/s$/, '') === lower.replace(/s$/, '');
  });
  if (idx >= 0) {
    const existing = familyData.groceryList[idx];
    if (!existing.meals) existing.meals = [];
    if (!existing.meals.includes(mealLower)) existing.meals.push(mealLower);
  } else {
    familyData.groceryList.push({ name: ingredient, checked: false, source: 'human', meals: [mealLower] });
  }
  saveFamily();
  renderGroceryList();
}

// ========== INIT ==========
connectWS();
refreshStatus();
loadTasks();
loadAllSessions();
loadSkillsForAutocomplete();
setInterval(refreshStatus, 10000);
