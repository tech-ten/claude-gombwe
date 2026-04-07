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
      <span>${s.tasks.running} running / ${s.tasks.total} tasks</span>
      <span>${s.skills} skills</span>
      <span>${s.cronJobs} jobs</span>
      <span style="margin-top:4px;font-size:10px;color:var(--text-4)">Cmd+K to search</span>
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
      if (conv && conv.title === conv.key && s.messageCount > 0) {
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

// ========== INIT ==========
connectWS();
refreshStatus();
loadTasks();
loadAllSessions();
loadSkillsForAutocomplete();
setInterval(refreshStatus, 10000);
