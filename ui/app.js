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
    case 'eero:sample':
    case 'eero:new-device':
    case 'eero:device-online':
    case 'eero:device-offline':
    case 'eero:profile-paused':
    case 'eero:profile-unpaused':
    case 'eero:speedtest':
      handleEeroEvent(event);
      break;
    case 'eero:alert':
      handleEeroAlertEvent(event);
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
    const now = new Date().toISOString();
    chatConversations.set(key, {
      key,
      title: firstMsg ? firstMsg.slice(0, 50) : key,
      channel: key.split(':')[0] || 'web',
      messages: [],
      createdAt: now,
      lastActiveAt: now,
    });
  }
  const conv = chatConversations.get(key);
  conv.lastActiveAt = new Date().toISOString();
  return conv;
}

function renderChatSidebar() {
  const list = document.getElementById('sidebarList');
  list.innerHTML = '';
  const sorted = Array.from(chatConversations.values())
    .sort((a, b) => new Date(b.lastActiveAt || b.createdAt).getTime() - new Date(a.lastActiveAt || a.createdAt).getTime());

  for (const conv of sorted) {
    if (chatFilter !== 'all' && conv.channel !== chatFilter) continue;
    const div = document.createElement('div');
    div.className = `sidebar-item${conv.key === activeSessionKey ? ' active' : ''}`;
    div.onclick = () => openChat(conv.key);
    div.innerHTML = `
      <div class="si-title">${esc(conv.title)}</div>
      <div class="si-meta">
        <span>${timeAgo(conv.lastActiveAt || conv.createdAt)}</span>
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
  // On mobile, opening a chat = navigate into the detail panel.
  // Desktop ignores this class (both panels always visible there).
  document.querySelector('#tab-chat .split-view')?.classList.add('viewing-detail');
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
  document.querySelector('#tab-tasks .split-view')?.classList.add('viewing-detail');
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
      case 'eero': loadEero(); break;
    }
  });
});

document.querySelectorAll('[data-kids-preset]').forEach(b => {
  b.addEventListener('click', () => applyKidsPreset(b.dataset.kidsPreset));
});

document.getElementById('dnsPointBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('dnsPointBtn');
  btn.disabled = true; btn.textContent = 'Pointing…';
  try {
    await fetch(`${API}/api/eero/dns/point-at-nextdns`, eeroPost({}));
    // The PUT always returns 200; eero may silently ignore it on free tier.
    // Re-sync and re-test so the indicator shows the truth either way.
    await eeroSync();
    await loadNextDNS();
    setTimeout(refreshDnsTestResult, 2000);
    setTimeout(refreshDnsTestResult, 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Point eero at NextDNS';
  }
});

document.getElementById('dnsResetBtn')?.addEventListener('click', async () => {
  if (!confirm('Reset eero DNS to automatic (Cloudflare via your ISP)?')) return;
  await fetch(`${API}/api/eero/dns/reset`, eeroPost({}));
  await eeroSync();
  await loadNextDNS();
});

document.getElementById('kidsDenylistForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('kidsDenylistInput');
  const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!domain) return;
  const r = await fetch(`${API}/api/nextdns/denylist`, eeroPost({ domain }));
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Failed to block');
    return;
  }
  input.value = '';
  showEeroToast(`Blocked ${domain}`);
  loadNextDNS();
});

document.getElementById('kidsAllowlistForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('kidsAllowlistInput');
  const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!domain) return;
  await fetch(`${API}/api/nextdns/allowlist`, eeroPost({ domain }));
  input.value = '';
  loadNextDNS();
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
  { cmd: '/meals', desc: 'View weekly plan, grocery list, pantry', type: 'cmd' },
  { cmd: '/dinner', desc: 'Add dinner (e.g. /dinner wed Chicken curry)', type: 'cmd' },
  { cmd: '/breakfast', desc: 'Add breakfast (e.g. /breakfast sat Pancakes)', type: 'cmd' },
  { cmd: '/lunch', desc: 'Add lunch (e.g. /lunch thu Caesar salad)', type: 'cmd' },
  { cmd: '/list', desc: 'View or add to shopping list (e.g. /list milk, eggs)', type: 'cmd' },
  { cmd: '/buy', desc: 'Order items (e.g. /buy or /buy hair remover)', type: 'action' },
  { cmd: '/family', desc: 'Manage family members (add/remove/list)', type: 'cmd' },
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
          lastActiveAt: s.lastActiveAt || s.createdAt || new Date().toISOString(),
        });
      }
      const conv = chatConversations.get(s.key);
      if (conv) conv.lastActiveAt = s.lastActiveAt || conv.lastActiveAt;
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

// ========== MOBILE: BACK-TO-LIST IN SPLIT-VIEW TABS ==========
// Each chat/tasks detail-header has a back-arrow button that, on mobile,
// returns the user to the list of conversations / tasks. The class
// `viewing-detail` on `.split-view` is what hides the list and shows
// the detail; the back button removes that class.
document.querySelectorAll('.back-to-list').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.closest('.split-view')?.classList.remove('viewing-detail');
  });
});

// When the user clicks a top-level sidebar nav-item to enter Chat or
// Tasks, they should land on the LIST (not whatever detail was last
// open). Clearing the class achieves that.
document.querySelectorAll('.nav-item').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.split-view.viewing-detail')
      .forEach(sv => sv.classList.remove('viewing-detail'));
  });
});

// ========== SIDEBAR TOGGLE / MOBILE DRAWER ==========
// On desktop the hamburger collapses the sidebar to icon-only.
// On mobile (<768px) the sidebar is hidden by default and slides in as a drawer.
// Tablet (768-1024) auto-collapses via CSS; toggle there is a no-op visually.
(function () {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('drawerBackdrop');
  const toggleBtn = document.getElementById('sidebarToggle');
  const mobileMql = window.matchMedia('(max-width: 767px)');

  function closeDrawer() {
    sidebar.classList.remove('drawer-open');
    backdrop?.classList.remove('show');
  }

  toggleBtn?.addEventListener('click', () => {
    if (mobileMql.matches) {
      const open = sidebar.classList.toggle('drawer-open');
      backdrop?.classList.toggle('show', open);
    } else {
      sidebar.classList.toggle('collapsed');
    }
  });

  backdrop?.addEventListener('click', closeDrawer);

  // Tapping any nav-item on mobile closes the drawer (the user has navigated)
  document.querySelectorAll('.nav-item').forEach(b => {
    b.addEventListener('click', () => { if (mobileMql.matches) closeDrawer(); });
  });

  // If the viewport crosses the mobile breakpoint while the drawer is open,
  // close it so the desktop layout doesn't render with leftover drawer state.
  mobileMql.addEventListener('change', closeDrawer);
})();

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
  // Fetch the auxiliary grocery-intelligence files in parallel — none of
  // them block render; missing files just produce empty sections.
  await Promise.all([
    loadRecipes(),
    loadDeals(),
    loadMealPlan(),
    loadWatchlist(),
  ]);
  renderAll();
}

function renderAll() {
  renderMembers();
  renderWeekGrid();
  renderGroceryList();
  renderNonFoodList();
  renderPantryList();
  renderDeals();
  renderMealPlan();
  renderRecipes();
  renderWatchlist();
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
      renderWeekGrid();
      // Refresh recipes to show the new/updated recipe
      await loadRecipes();
    }
  } catch {}
}

function renderMembers() {
  const list = document.getElementById('memberList');
  if (!list) return;
  const members = familyData.members || [];

  if (members.length === 0) {
    list.innerHTML = '<div class="empty-list">No family members yet. Add members to scale recipes and track dietary needs.</div>';
    return;
  }

  const adults = members.filter(m => m.type === 'adult').length;
  const children = members.filter(m => m.type === 'child').length;

  list.innerHTML = '';
  members.forEach((member, idx) => {
    const div = document.createElement('div');
    div.className = 'member-item';
    div.innerHTML = `
      <div class="member-info">
        <span class="member-name">${esc(member.name)}</span>
        <span class="member-type">${member.type}</span>
        ${member.dietary ? `<span class="member-dietary">${esc(member.dietary)}</span>` : ''}
      </div>
      <button class="member-remove" data-idx="${idx}">remove</button>
    `;
    list.appendChild(div);
  });

  // Summary row
  const summary = document.createElement('div');
  summary.className = 'member-summary';
  summary.textContent = `${members.length} member${members.length !== 1 ? 's' : ''} — ${adults} adult${adults !== 1 ? 's' : ''}${children ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}`;
  list.appendChild(summary);

  list.querySelectorAll('.member-remove').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      const removed = familyData.members[idx];
      logAction('user', 'member removed', removed.name);
      familyData.members.splice(idx, 1);
      saveFamily();
      renderMembers();
    });
  });
}

// Add member button
document.getElementById('addMemberBtn')?.addEventListener('click', () => {
  const name = prompt('Name:');
  if (!name) return;
  const type = prompt('Type (adult or child):', 'adult');
  if (type !== 'adult' && type !== 'child') { alert('Must be "adult" or "child"'); return; }
  const dietary = prompt('Dietary notes (optional — e.g. "vegetarian", "no dairy"):', '');

  if (!familyData.members) familyData.members = [];
  const member = { name: name.trim(), type };
  if (dietary && dietary.trim()) member.dietary = dietary.trim();
  familyData.members.push(member);
  logAction('user', 'member added', `${member.name} (${member.type}${member.dietary ? ', ' + member.dietary : ''})`);
  saveFamily();
  renderMembers();
});

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

// Order Now — orders CHECKED items only, moves them to pantry
document.getElementById('orderGroceriesBtn')?.addEventListener('click', async () => {
  const groceries = (familyData.groceryList || []).filter(i => i.checked).map(i => i.name);
  const nonFood = (familyData.nonFoodList || []).filter(i => i.checked).map(i => i.name);
  const all = [...groceries, ...nonFood];
  if (all.length === 0) { alert('No items selected. Tick the items you want to order.'); return; }

  const summary = `Groceries (${groceries.length}):\n${groceries.join(', ')}\n\nHousehold (${nonFood.length}):\n${nonFood.join(', ')}`;
  if (!confirm(`Order ${all.length} selected items via Gombwe?\n\n${summary}`)) return;

  logAction('user', 'order placed', `${all.length} items (${groceries.length} grocery, ${nonFood.length} household)`);
  if (!familyData.pantry) familyData.pantry = [];
  for (const name of groceries) {
    if (!familyData.pantry.some(p => p.toLowerCase() === name.toLowerCase())) {
      familyData.pantry.push(name);
    }
  }
  // Remove ordered items, keep unchecked ones on the list
  familyData.groceryList = (familyData.groceryList || []).filter(i => !i.checked);
  familyData.nonFoodList = (familyData.nonFoodList || []).filter(i => !i.checked);
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

// ── Today's Deals ────────────────────────────────────────────────────
//
// Reads /api/family/deals (which reads grocery-deals-latest.json). Surfaces
// rock-bottom items + Coles/Woolworths cart totals + free-delivery status.
// Selected items can be pushed straight into familyData.groceryList — then
// the existing Order Now button picks them up.

let dealsData = null;        // last snapshot fetched
const selectedDealNames = new Set();   // user's tick selection

async function loadDeals() {
  try {
    const res = await fetch(`${API}/api/family/deals`);
    const j = await res.json();
    dealsData = j?.rock_bottom ? j : null;
  } catch { dealsData = null; }
}

function renderDeals() {
  const container = document.getElementById('dealsList');
  const metaEl = document.getElementById('dealsMeta');
  if (!container) return;

  if (!dealsData) {
    container.innerHTML = '<div class="empty-list">No price-watcher snapshot yet. The daily 06:00 cron writes it; or run <code>node scripts/grocery-watch.mjs</code> manually.</div>';
    if (metaEl) metaEl.textContent = '';
    return;
  }

  const rb = dealsData.rock_bottom || [];
  const w = dealsData.carts?.woolworths;
  const c = dealsData.carts?.coles;
  if (metaEl) {
    const wTxt = w ? `W: $${w.total}${w.free_delivery ? ' ✓ free' : ` (need $${(75 - w.total).toFixed(2)} more)`}` : '';
    const cTxt = c ? `C: $${c.total}${c.free_delivery ? ' ✓ free' : ` (need $${(50 - c.total).toFixed(2)} more)`}` : '';
    metaEl.textContent = `${rb.length} rock-bottom · ${wTxt} · ${cTxt}`;
  }

  if (rb.length === 0) {
    container.innerHTML = '<div class="empty-list">Nothing at rock-bottom right now. Watching ' + (dealsData.items?.length ?? '?') + ' items; check back tomorrow.</div>';
    return;
  }

  container.innerHTML = rb.map(item => {
    const name = item.name;
    const checked = selectedDealNames.has(name);
    const price = item.best?.price?.toFixed(2) ?? '?';
    const store = item.best?.store ?? '?';
    return `
      <label class="deal-row">
        <input type="checkbox" data-deal-name="${esc(name)}" ${checked ? 'checked' : ''}>
        <span class="deal-name">${esc(name)}</span>
        <span class="deal-price">$${price} <span class="deal-store">${esc(store)}</span></span>
        <span class="deal-ceiling">ceiling $${item.max_price}</span>
      </label>
    `;
  }).join('');

  container.querySelectorAll('input[data-deal-name]').forEach(cb => {
    cb.addEventListener('change', () => {
      const n = cb.dataset.dealName;
      if (cb.checked) selectedDealNames.add(n); else selectedDealNames.delete(n);
    });
  });
}

document.getElementById('dealsImportBtn')?.addEventListener('click', async () => {
  const names = [...selectedDealNames];
  if (names.length === 0) { alert('Tick at least one deal first.'); return; }
  try {
    const res = await fetch(`${API}/api/family/grocery/import-deals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'unknown error');
    logAction('user', 'deals imported', `${j.added} item(s) added to grocery list`);
    selectedDealNames.clear();
    await loadFamily();   // re-fetch + re-render everything (now Grocery List has the new items pre-ticked)
  } catch (err) {
    alert(`Couldn't import: ${err.message}`);
  }
});

// ── Suggested Dinner Plan ────────────────────────────────────────────
//
// Reads /api/family/meal-plan. Shows 7-day picks with per-person mods.
// "Regenerate" fires the planner. "Apply to Week" writes dinners into
// familyData.meals (the existing Week grid).

let planData = null;

async function loadMealPlan() {
  try {
    const res = await fetch(`${API}/api/family/meal-plan`);
    const j = await res.json();
    planData = j?.dinners ? j : null;
  } catch { planData = null; }
}

function renderMealPlan() {
  const container = document.getElementById('planList');
  const metaEl = document.getElementById('planMeta');
  if (!container) return;

  if (!planData) {
    container.innerHTML = '<div class="empty-list">No plan generated yet. Sunday 17:00 cron writes it; or click <strong>Regenerate</strong> to run it now.</div>';
    if (metaEl) metaEl.textContent = '';
    return;
  }

  const bc = planData.budget_context || {};
  if (metaEl) {
    metaEl.textContent = `${planData.days || 7} days · $${planData.totals?.est_cost ?? '?'} total · $${bc.daily_allowance ?? '?'}/day allowance`;
  }

  const rows = (planData.dinners || []).map(d => {
    if (d.status !== 'planned') {
      return `<div class="plan-row"><span class="plan-date">${esc(d.date)}</span><span class="plan-name muted">${esc(d.status)}</span></div>`;
    }
    const flag = d.over_daily_allowance ? '<span class="plan-flag" title="Over daily budget">⚠</span>' : '';
    const mods = d.modifications && Object.keys(d.modifications).length
      ? `<details class="plan-mods"><summary>${Object.keys(d.modifications).length} mods</summary>${Object.entries(d.modifications).map(([w, m]) => `<div><span class="recipe-mod-who">${esc(w)}</span>: ${esc(m)}</div>`).join('')}</details>`
      : '';
    return `
      <div class="plan-row">
        <span class="plan-date">${esc(d.date)}</span>
        <span class="plan-name">${esc(d.name)}</span>
        <span class="plan-cost">$${d.est_cost_aud ?? '?'}</span>
        ${flag}
        ${mods}
      </div>
    `;
  }).join('');
  container.innerHTML = rows;
}

document.getElementById('planRegenBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('planRegenBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Regenerating…'; }
  try {
    const res = await fetch(`${API}/api/family/meal-plan/regenerate`, { method: 'POST' });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'regen failed');
    planData = j.plan;
    logAction('gombwe', 'meal plan regenerated', `${planData?.dinners?.length || 0} day(s)`);
    renderMealPlan();
  } catch (err) {
    alert(`Couldn't regenerate: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }
  }
});

document.getElementById('planApplyBtn')?.addEventListener('click', async () => {
  if (!planData) { alert('No plan to apply. Click Regenerate first.'); return; }
  const force = confirm('Apply the plan to the Week grid?\n\nOK: only fill EMPTY dinner slots (preserves your manual entries).\nCancel: do nothing.\n\nTo overwrite existing entries too, hold Shift while clicking.');
  if (!force) return;
  const useForce = window.event?.shiftKey === true;   // shift = overwrite
  try {
    const res = await fetch(`${API}/api/family/meal-plan/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: useForce }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'apply failed');
    logAction('user', 'meal plan applied', `${j.applied} dinner(s) written, ${j.skipped} preserved`);
    await loadFamily();
  } catch (err) {
    alert(`Couldn't apply: ${err.message}`);
  }
});

// ── Watchlist ────────────────────────────────────────────────────────
//
// Reads /api/family/watchlist (decorated with latest prices). Inline-editable
// max_price. Add new items via the form below the list. Remove via × button.

let watchlistData = { items: [] };

async function loadWatchlist() {
  try {
    const res = await fetch(`${API}/api/family/watchlist`);
    watchlistData = await res.json();
    if (!watchlistData.items) watchlistData.items = [];
  } catch { watchlistData = { items: [] }; }
}

function renderWatchlist() {
  const container = document.getElementById('watchlistList');
  const metaEl = document.getElementById('watchlistMeta');
  if (!container) return;
  const items = watchlistData.items || [];
  if (metaEl) metaEl.textContent = `${items.length} item(s) tracked`;

  if (items.length === 0) {
    container.innerHTML = '<div class="empty-list">No watchlist yet. Add items below; the 06:00 cron starts polling tomorrow.</div>';
    return;
  }

  // Group by category for readability
  const byCat = {};
  for (const i of items) (byCat[i.category || 'other'] ??= []).push(i);

  let html = '';
  for (const cat of Object.keys(byCat).sort()) {
    html += `<div class="wl-cat-head">${esc(cat)}</div>`;
    for (const item of byCat[cat]) {
      const wPrice = item.latest?.w != null ? `$${item.latest.w.toFixed(2)}` : '—';
      const cPrice = item.latest?.c != null ? `$${item.latest.c.toFixed(2)}` : '—';
      html += `
        <div class="wl-row">
          <span class="wl-name">${esc(item.name)}</span>
          <span class="wl-prices">W: ${wPrice} · C: ${cPrice}</span>
          <span class="wl-max">max
            <input type="number" class="wl-max-input" data-wl-name="${esc(item.name)}" value="${item.max_price}" step="0.01" min="0">
          </span>
          <button class="wl-remove" data-wl-remove="${esc(item.name)}" title="Remove from watchlist">×</button>
        </div>
      `;
    }
  }
  container.innerHTML = html;

  // Wire inline max_price edits
  container.querySelectorAll('.wl-max-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const name = inp.dataset.wlName;
      const newMax = parseFloat(inp.value);
      if (!isFinite(newMax) || newMax <= 0) { renderWatchlist(); return; }
      const found = (watchlistData.items || []).find(i => i.name === name);
      if (!found) return;
      try {
        const res = await fetch(`${API}/api/family/watchlist`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', item: { ...found, max_price: newMax } }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'failed');
        found.max_price = newMax;
        logAction('user', 'watchlist edited', `${name}: max $${newMax}`);
      } catch (err) {
        alert(`Couldn't update: ${err.message}`);
        renderWatchlist();
      }
    });
  });

  // Wire remove buttons
  container.querySelectorAll('[data-wl-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.wlRemove;
      if (!confirm(`Remove "${name}" from the watchlist?`)) return;
      try {
        const res = await fetch(`${API}/api/family/watchlist`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', item: { name } }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || 'failed');
        watchlistData.items = (watchlistData.items || []).filter(i => i.name !== name);
        logAction('user', 'watchlist removed', name);
        renderWatchlist();
      } catch (err) {
        alert(`Couldn't remove: ${err.message}`);
      }
    });
  });
}

document.getElementById('watchlistAddForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name     = document.getElementById('wlName')?.value.trim();
  const maxPrice = parseFloat(document.getElementById('wlMax')?.value);
  const category = document.getElementById('wlCategory')?.value.trim().toLowerCase();
  if (!name || !isFinite(maxPrice) || !category) { alert('Need name, max price, and category.'); return; }
  try {
    const res = await fetch(`${API}/api/family/watchlist`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', item: { name, max_price: maxPrice, category } }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'failed');
    logAction('user', 'watchlist added', `${name} (max $${maxPrice})`);
    e.target.reset();
    await loadWatchlist();
    renderWatchlist();
  } catch (err) {
    alert(`Couldn't add: ${err.message}`);
  }
});

function ingredientDisplay(ing) {
  // Old format: strings. New format (post dinner-bank merge): {name, qty, where_to_get, watchlist_match}.
  if (typeof ing === 'string') return ing;
  if (ing && typeof ing === 'object') {
    return ing.name + (ing.qty ? ' — ' + ing.qty : '');
  }
  return String(ing);
}

function renderRecipes() {
  const container = document.getElementById('recipeList');
  if (!container) return;
  // Filter out the merged-file metadata key + sort
  const names = Object.keys(recipesData).filter(n => !n.startsWith('_')).sort();

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

    // Metadata enriched recipes (from dinner-bank merge) carry category, cost,
    // prep, modifications, diet_tags. Surface them when present.
    const isObjectIngredients = ingredients.some(i => typeof i !== 'string');
    const catBadge = recipe.category ? `<span class="recipe-cat-badge cat-${esc(recipe.category)}">${esc(recipe.category)}</span>` : '';
    const metaBits = [];
    if (recipe.main_protein) metaBits.push(esc(recipe.main_protein));
    if (typeof recipe.est_cost_aud === 'number') metaBits.push(`~$${recipe.est_cost_aud} for 6`);
    if (recipe.prep_minutes) metaBits.push(`${recipe.prep_minutes} min`);
    if (recipe.leftovers_pack) metaBits.push('leftovers OK');
    const metaLine = metaBits.length ? `<div class="recipe-meta">${metaBits.join(' · ')}</div>` : '';

    let ingredientsHtml = '';
    ingredients.forEach((ing, idx) => {
      const display = ingredientDisplay(ing);
      const editable = typeof ing === 'string';   // only string ingredients are click-to-edit
      const isHuman = editable && prefs[ing] === 'human';
      const tag = !editable
        ? '<span class="recipe-ingredient-tag struct">structured</span>'
        : isHuman
          ? '<span class="recipe-ingredient-tag human">preference</span>'
          : '<span class="recipe-ingredient-tag auto">auto</span>';
      const nameAttrs = editable
        ? `class="recipe-ingredient-name" data-recipe="${esc(name)}" data-idx="${idx}"`
        : `class="recipe-ingredient-name recipe-ingredient-name-struct"`;
      ingredientsHtml += `
        <div class="recipe-ingredient">
          <span ${nameAttrs}>${esc(display)}</span>
          ${tag}
          <button class="recipe-ingredient-remove" data-recipe="${esc(name)}" data-idx="${idx}">remove</button>
        </div>
      `;
    });

    const modsHtml = recipe.modifications && Object.keys(recipe.modifications).length
      ? `<div class="recipe-mods"><div class="recipe-mods-title">Per-person modifications</div>` +
        Object.entries(recipe.modifications).map(([who, mod]) =>
          `<div class="recipe-mod"><span class="recipe-mod-who">${esc(who)}</span>: ${esc(mod)}</div>`
        ).join('') + `</div>`
      : '';

    const dietHtml = recipe.diet_tags?.length
      ? `<div class="recipe-tags">${recipe.diet_tags.map(t => `<span class="recipe-tag">${esc(t)}</span>`).join(' ')}</div>`
      : '';

    card.innerHTML = `
      <div class="recipe-header" data-recipe="${esc(name)}">
        <span class="recipe-name">${esc(name)} ${catBadge}</span>
        <span class="recipe-count">${ingredients.length} ingredients</span>
      </div>
      ${metaLine}
      <div class="recipe-body${expanded ? '' : ' collapsed'}">
        ${ingredientsHtml}
        ${isObjectIngredients ? '' : `
        <form class="recipe-add-form" data-recipe="${esc(name)}">
          <input type="text" placeholder="Add ingredient..." data-recipe="${esc(name)}">
          <button type="submit" class="btn-primary btn-sm">Add</button>
        </form>`}
        ${recipe.recipe ? `<div class="recipe-instructions">${esc(recipe.recipe)}</div>` : ''}
        ${modsHtml}
        ${dietHtml}
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

// ========== EERO (NETWORK) ==========
let eeroState = { authenticated: false, snapshot: null, config: null, actions: [], alerts: [], schedules: [] };

// MikroTik-driven device list — the canonical source for the Devices subtab.
// eeroState.snapshot.devices is kept for eero AP-level decoration (signal,
// connection_type) but is no longer the primary data source per the
// MikroTik-first architecture (see docs/network-architecture.md).
let networkState = { devices: [], loaded: false };
// MACs of devices whose detail panel is open. Preserved across re-renders.
const expandedDevices = new Set();

async function loadNetworkDevices() {
  try {
    const res = await fetch(`${API}/api/network/devices`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    networkState.devices = await res.json();
    networkState.loaded = true;
  } catch (err) {
    console.warn('loadNetworkDevices failed:', err.message);
    networkState.loaded = false;
  }
}

async function refreshDevicesPanel() {
  await loadNetworkDevices();
  renderEeroDevices();   // function name kept for minimum churn; reads networkState now
}

// ── Device drill-down (ported from /ui/network.html) ─────────────────
//
// Click a device row's body to expand a details panel showing: IP, MAC,
// vendor + Apple model code (mDNS), Bonjour services, last seen, active
// conntrack count, today's bytes (down + up), top destinations, and
// async-loaded recent DNS history.

function renderDeviceDetail(d) {
  const model = d.model_friendly || d.model;
  const modelLine = model
    ? `<div class="dd-row"><span class="dd-k">Model</span><span class="dd-v">${esc(d.model_friendly && d.model && d.model_friendly !== d.model ? `${d.model_friendly} (${d.model})` : model)}</span></div>`
    : '';
  const mdnsLine = d.mdns_services?.length
    ? `<div class="dd-row"><span class="dd-k">Bonjour</span><span class="dd-v">${esc(d.mdns_services.slice(0, 6).join(', '))}</span></div>`
    : '';

  const dests = d.top_destinations_today || [];
  const destsHtml = dests.length
    ? dests.map(t => `<li><span class="dd-host">${esc(t.host)}</span><span class="dd-bytes">${esc(formatBytes(t.bytes || 0))}</span></li>`).join('')
    : '<li><span class="dd-host muted">No traffic recorded today</span></li>';

  // Blocked-categories checkbox row. Shown for every device — for adults it
  // defaults to empty; for kid-flagged devices it auto-seeds adult+gambling+
  // dangerous on first add. Toggling here fires a PUT and is audit-logged.
  const POLICY_CATS = ['dangerous', 'adult', 'gambling', 'ads', 'social'];
  const active = new Set(d.blocked_categories || []);
  const policyRow = `
    <div class="dd-policy">
      <span class="dd-policy-label">Blocked categories</span>
      <span class="dd-policy-cats">
        ${POLICY_CATS.map(cat => `
          <label class="dd-policy-cat" data-cat="${esc(cat)}">
            <input type="checkbox" data-device-policy-toggle data-mac="${esc(d.mac)}" data-cat="${esc(cat)}" ${active.has(cat) ? 'checked' : ''}>
            <span class="dd-policy-swatch" style="background:${CATEGORY_COLORS?.[cat] || '#999'}"></span>
            <span>${cat}</span>
          </label>`).join('')}
      </span>
      <span class="muted small" data-device-policy-status></span>
    </div>
  `;

  return `
    <div class="eero-device-detail" data-detail-mac="${esc(d.mac)}">
      <div class="dd-grid">
        <div class="dd-col">
          <div class="dd-row"><span class="dd-k">IP</span><span class="dd-v"><code>${esc(d.ip || '—')}</code></span></div>
          <div class="dd-row"><span class="dd-k">MAC</span><span class="dd-v"><code>${esc(d.mac)}</code></span></div>
          <div class="dd-row"><span class="dd-k">Vendor</span><span class="dd-v">${esc(d.vendor || 'Unknown')}</span></div>
          ${modelLine}
          ${mdnsLine}
          <div class="dd-row"><span class="dd-k">Last seen</span><span class="dd-v">${esc(timeAgo(d.last_seen) || '—')}</span></div>
          <div class="dd-row"><span class="dd-k">Connections</span><span class="dd-v"><code>${d.active_connections ?? 0}</code></span></div>
          <div class="dd-row"><span class="dd-k">Today</span><span class="dd-v">${formatBytes(d.today_bytes_down || 0)} down · ${formatBytes(d.today_bytes_up || 0)} up</span></div>
        </div>
        <div class="dd-col">
          <div class="dd-title">Destinations <span class="dd-sub">${dests.length ? `(${dests.length} unique today)` : ''}</span></div>
          <ol class="dd-dests">${destsHtml}</ol>
        </div>
        <div class="dd-col">
          <div class="dd-title">DNS queries <span class="dd-sub" data-dns-count></span></div>
          <ol class="dd-dns" data-dns-list><li class="muted">Loading…</li></ol>
        </div>
      </div>
      ${policyRow}
    </div>
  `;
}

// Per-device category toggle handler — delegated, so it survives re-renders.
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.matches('[data-device-policy-toggle]')) return;
  const mac = t.dataset.mac;
  const detail = document.querySelector(`[data-detail-mac="${CSS.escape(mac)}"]`);
  const status = detail?.querySelector('[data-device-policy-status]');
  // Snapshot current ticked state from the DOM (this includes the in-flight change).
  const ticks = detail?.querySelectorAll('[data-device-policy-toggle]:checked') || [];
  const categories = Array.from(ticks).map(el => el.dataset.cat);
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch(`${API}/api/network/devices/${encodeURIComponent(mac)}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (status) status.textContent = `Saved · ${categories.length} blocked`;
    // Reflect in our cached device row so a re-render preserves the state.
    const dev = (networkState?.devices || []).find(x => x.mac === mac);
    if (dev) dev.blocked_categories = categories;
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
    t.checked = !t.checked;  // revert
  }
});

async function loadDeviceDnsHistory(mac, ip) {
  if (!ip) return;
  const detail = document.querySelector(`[data-detail-mac="${CSS.escape(mac)}"]`);
  if (!detail) return;
  const listEl = detail.querySelector('[data-dns-list]');
  const countEl = detail.querySelector('[data-dns-count]');
  try {
    const res = await fetch(`${API}/api/network/dns/recent?client=${encodeURIComponent(ip)}&limit=500`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      listEl.innerHTML = '<li class="muted">No DNS queries yet — try again in 30s.</li>';
      countEl.textContent = '';
      return;
    }
    const byHost = new Map();
    for (const q of data) {
      const e = byHost.get(q.hostname) ?? { count: 0, last_ts: '', blocked: false };
      e.count += 1;
      if (q.ts > e.last_ts) e.last_ts = q.ts;
      if (q.blocked) e.blocked = true;
      byHost.set(q.hostname, e);
    }
    countEl.textContent = `(${data.length} queries · ${byHost.size} unique hostnames)`;
    listEl.innerHTML = [...byHost.entries()]
      .sort((a, b) => b[1].last_ts.localeCompare(a[1].last_ts))
      .map(([host, e]) => `
        <li class="dd-dns-row ${e.blocked ? 'is-blocked' : ''}">
          <span class="dd-host">${esc(host)}</span>
          <span class="dd-dns-meta">${esc(timeAgo(e.last_ts) || '')} · ${e.count}×${e.blocked ? ' · blocked' : ''}</span>
        </li>`).join('');
  } catch (err) {
    listEl.innerHTML = `<li class="muted">Couldn't load DNS history: ${esc(err.message)}</li>`;
    countEl.textContent = '';
  }
}
let eeroSchedEditingId = null;
let eeroSelectedDevices = new Set();
let eeroActiveSubtab = 'overview';
let eeroDeviceQuery = '';
let eeroDeviceSort = 'recent';
let eeroDeviceFilter = 'all';
let eeroHistory = [];
let eeroLastLoginId = null;

async function loadEero() {
  try {
    const res = await fetch(`${API}/api/eero`);
    eeroState = await res.json();
  } catch { return; }
  renderEero();

  if (eeroState.authenticated) {
    try {
      const h = await fetch(`${API}/api/eero/history?limit=500`);
      eeroHistory = await h.json();
    } catch { eeroHistory = []; }
    try {
      const s = await fetch(`${API}/api/eero/schedules`);
      eeroState.schedules = await s.json();
    } catch { eeroState.schedules = []; }
    renderEeroOverview();
    renderEeroUsageChart();
    renderEeroSchedule();
  }
  // MikroTik-driven alerts load alongside eero alerts. The banner merges
  // both in renderEeroAlerts().
  await loadNetworkAlerts();
  renderEeroAlerts();
  updateEeroNavBadge();
  // Devices subtab is MikroTik-driven — load even when eero isn't authenticated,
  // because gombwe is fully functional without eero (per the MikroTik-first
  // architecture in docs/network-architecture.md).
  await loadNetworkDevices();
  renderEeroDevices();
}

function renderEero() {
  const auth = document.getElementById('eeroAuth');
  const subnav = document.getElementById('eeroSubnav');
  const panes = document.querySelectorAll('.eero-pane');

  if (!eeroState.authenticated) {
    auth.classList.remove('hidden');
    subnav.classList.add('hidden');
    panes.forEach(p => p.classList.add('hidden'));
    return;
  }

  auth.classList.add('hidden');
  subnav.classList.remove('hidden');
  panes.forEach(p => p.classList.remove('hidden'));

  setEeroSyncState();
  renderEeroOverview();
  renderEeroDevices();
  renderEeroProfiles();
  renderEeroUsageChart();
  renderEeroSpeed();
  renderEeroAdvanced();
  renderEeroAudit();
}

function setEeroSyncState() {
  const el = document.getElementById('eeroSyncState');
  if (!el) return;
  const snap = eeroState.snapshot;
  if (!snap) { el.textContent = 'Never synced'; return; }
  const errs = snap.errors ? Object.keys(snap.errors).length : 0;
  el.textContent = `Synced ${timeAgo(snap.syncedAt)} ago${errs ? ` · ${errs} errors` : ''}`;
}

// MikroTik-driven Overview (step 6 of the network rationalisation).
// Pulls /api/network/status + devices + policy/actions in parallel and renders
// router vitals, today's enforcement summary, top devices, per-device policy.
// Function name kept (renderEeroOverview) so existing call sites keep working;
// will be renamed in the final cleanup pass.
let overviewCachedStatus = null;
let overviewLastLoadAt = 0;

async function loadOverviewData() {
  // Coalesce frequent calls — fetch at most every 8s.
  if (Date.now() - overviewLastLoadAt < 8000 && overviewCachedStatus) return overviewCachedStatus;
  try {
    const [status, devices, actions] = await Promise.all([
      fetch(`${API}/api/network/status`).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/network/devices`).then(r => r.ok ? r.json() : []),
      fetch(`${API}/api/network/policy/actions`).then(r => r.ok ? r.json() : []),
    ]);
    overviewCachedStatus = { status, devices, actions };
    overviewLastLoadAt = Date.now();
  } catch (err) {
    console.warn('loadOverviewData failed:', err.message);
  }
  return overviewCachedStatus;
}

async function renderEeroOverview() {
  const statGrid = document.getElementById('overviewStats');
  if (!statGrid) return;  // pane not in DOM yet
  const data = await loadOverviewData();
  if (!data || !data.status) {
    statGrid.innerHTML = '<div class="muted small">MikroTik not reachable.</div>';
    return;
  }
  const { status, devices, actions } = data;

  // ── Top stat row ────────────────────────────────────────────
  const r = status.router || {};
  const bw = status.current_bandwidth || {};
  statGrid.innerHTML = `
    ${eeroStat('Router', r.model || '—', `${r.version || ''} · uptime ${esc(formatRouterUptime(r.uptime))}`)}
    ${eeroStat('Devices', `${status.online_count}/${status.known_count}`, 'online / known')}
    ${eeroStat('WAN', `${(bw.down_mbps || 0).toFixed(1)} ↓`, `${(bw.up_mbps || 0).toFixed(1)} ↑ Mbps`)}
    ${eeroStat('Conntrack', String(status.active_conntrack || 0), 'active flows')}
    ${eeroStat('CPU', `${r.cpu_load || 0}%`, 'router load')}
    ${eeroStat('Active blocks', String(status.active_blocks || 0), 'manual device blocks')}
  `;

  // ── Today's enforcement (filter audit log to today) ─────────
  const enforcementEl = document.getElementById('overviewEnforcement');
  const enforcementMeta = document.getElementById('overviewEnforcementMeta');
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todaysActions = (actions || []).filter(a => {
    const t = a.time || a.ts;
    return t && new Date(t).getTime() >= todayStart.getTime();
  });
  const byCat = new Map();
  const byMac = new Map();
  let scannerRuns = 0;
  for (const a of todaysActions) {
    if (a.action === 'blocked-by-category') {
      const cat = a.category || 'unknown';
      byCat.set(cat, (byCat.get(cat) || 0) + 1);
      const m = a.name || a.mac || '?';
      byMac.set(m, (byMac.get(m) || 0) + 1);
    }
    if (a.action === 'policy-scan-run') scannerRuns++;
  }
  if (enforcementMeta) enforcementMeta.textContent = `${todaysActions.length} actions today`;
  if (byCat.size === 0) {
    enforcementEl.innerHTML = '<div class="muted small">No category blocks fired today.</div>';
  } else {
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const devs = [...byMac.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    enforcementEl.innerHTML = `
      <div class="ov-enforcement-cats">
        ${cats.map(([cat, n]) => `
          <div class="ov-enforcement-cat">
            <span class="ov-swatch" style="background:${CATEGORY_COLORS?.[cat] || '#999'}"></span>
            <span class="ov-cat-name">${esc(cat)}</span>
            <span class="ov-cat-count">${n}</span>
          </div>`).join('')}
      </div>
      <div class="ov-enforcement-by-device">
        <div class="ov-sub-label">Most-blocked devices today</div>
        ${devs.map(([name, n]) => `
          <div class="ov-device-row">
            <span class="ov-device-name">${esc(name)}</span>
            <span class="ov-device-count">${n}</span>
          </div>`).join('')}
      </div>
    `;
  }

  // ── Top devices today (by bytes) ────────────────────────────
  const topEl = document.getElementById('overviewTopDevices');
  const ranked = (devices || [])
    .map(d => ({ d, total: (d.today_bytes_down || 0) + (d.today_bytes_up || 0) }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  if (ranked.length === 0) {
    topEl.innerHTML = '<div class="muted small">No traffic recorded yet today.</div>';
  } else {
    const maxBytes = ranked[0].total;
    topEl.innerHTML = ranked.map(r => {
      const label = r.d.name || r.d.hostname || r.d.mac;
      const pct = Math.max(2, Math.round((r.total / maxBytes) * 100));
      return `
        <div class="eero-consumer">
          <div class="eero-consumer-bar"><div class="eero-consumer-fill" style="width:${pct}%"></div></div>
          <div class="eero-consumer-label">${esc(label)}</div>
          <span class="muted small">${formatBytes(r.total)}</span>
        </div>`;
    }).join('');
  }

  // ── Per-device blocked categories summary ───────────────────
  const policyEl = document.getElementById('overviewPolicy');
  const policyMeta = document.getElementById('overviewPolicyMeta');
  const withPolicy = (devices || []).filter(d => (d.blocked_categories || []).length > 0);
  if (policyMeta) policyMeta.textContent = `${withPolicy.length} of ${devices?.length || 0} devices`;
  if (withPolicy.length === 0) {
    policyEl.innerHTML = '<div class="muted small">No devices have category blocks. Set policy under Devices.</div>';
  } else {
    policyEl.innerHTML = `
      <table class="eero-table">
        <thead><tr><th>Device</th><th>Owner</th><th>Blocked categories</th><th>Today's attempts</th></tr></thead>
        <tbody>
          ${withPolicy.map(d => {
            const cats = d.blocked_categories || [];
            const attempts = byMac.get(d.name || d.mac) || 0;
            return `
              <tr>
                <td>${esc(d.name || d.hostname || d.mac)}</td>
                <td class="muted small">${esc(d.owner || '—')}</td>
                <td>
                  ${cats.map(c => `<span class="ov-cat-pill"><span class="ov-swatch" style="background:${CATEGORY_COLORS?.[c] || '#999'}"></span>${esc(c)}</span>`).join('')}
                </td>
                <td class="muted small">${attempts || '—'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }
}

// RouterOS uptime strings come as "1w2d3h4m5s". Trim trailing zero-units for compactness.
function formatRouterUptime(s) {
  if (!s) return '';
  return String(s).replace(/0[smh]/g, '').replace(/^\s+|\s+$/g, '') || s;
}

function eeroStat(label, value, sub) {
  return `
    <div class="eero-stat">
      <div class="eero-stat-label">${esc(label)}</div>
      <div class="eero-stat-value">${esc(value)}</div>
      <div class="eero-stat-sub">${esc(sub || '')}</div>
    </div>
  `;
}

function summariseEeroUsage(usage) {
  let dl = 0, ul = 0;
  for (const s of (usage?.series || [])) {
    const total = (s.values || []).reduce((acc, v) => acc + (v.value || 0), 0);
    if (String(s.type).toLowerCase().includes('down')) dl += total;
    else if (String(s.type).toLowerCase().includes('up')) ul += total;
  }
  return { dl, ul };
}

function renderEeroDevices() {
  const list = document.getElementById('eeroDeviceList');
  if (!list) return;

  // Build a MAC → eero-device map for AP-layer decoration (optional sidecar)
  const eeroByMac = new Map();
  for (const d of (eeroState.snapshot?.devices || [])) {
    if (d.mac) eeroByMac.set(d.mac.toLowerCase(), d);
  }

  // MikroTik canonical list, decorated with eero AP info where present
  let devices = (networkState.devices || []).slice().map(d => {
    const eero = eeroByMac.get((d.mac || '').toLowerCase());
    return {
      ...d,
      ap: eero ? {
        connection_type: eero.connection_type,
        signal_strength: eero.signal_strength,
      } : null,
    };
  });

  // Search
  if (eeroDeviceQuery) {
    const q = eeroDeviceQuery.toLowerCase();
    devices = devices.filter(d =>
      (d.name || '').toLowerCase().includes(q) ||
      (d.hostname || '').toLowerCase().includes(q) ||
      (d.mac || '').toLowerCase().includes(q) ||
      (d.ip || '').toLowerCase().includes(q) ||
      (d.owner || '').toLowerCase().includes(q),
    );
  }

  // Filter (MikroTik doesn't distinguish paused vs blocked — they're the same)
  switch (eeroDeviceFilter) {
    case 'online':  devices = devices.filter(d => d.online); break;
    case 'offline': devices = devices.filter(d => !d.online); break;
    case 'paused':  devices = devices.filter(d => d.blocked); break;
    case 'blocked': devices = devices.filter(d => d.blocked); break;
    case 'unknown': devices = devices.filter(d => !d.owner && (!d.name || d.name === d.mac)); break;
  }

  // Sort
  switch (eeroDeviceSort) {
    case 'name':    devices.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break;
    case 'profile': devices.sort((a, b) => (a.owner || '').localeCompare(b.owner || '')); break;
    case 'status':  devices.sort((a, b) => Number(b.online || 0) - Number(a.online || 0)); break;
    default:        devices.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
  }

  if (devices.length === 0) {
    list.innerHTML = networkState.loaded
      ? '<div class="muted small" style="padding:16px">No devices match.</div>'
      : '<div class="muted small" style="padding:16px">Loading devices from MikroTik…</div>';
    document.getElementById('eeroBulkBar').classList.add('hidden');
    return;
  }

  // Owner dropdown options — union of current owners + family members
  const owners = new Set();
  for (const d of (networkState.devices || [])) if (d.owner) owners.add(d.owner);
  for (const m of (familyData.members || [])) if (m.name) owners.add(m.name);
  const ownerOpts = ['<option value="">— no owner —</option>']
    .concat([...owners].sort().map(o => `<option value="${esc(o)}">${esc(o)}</option>`))
    .join('');

  list.innerHTML = devices.map(d => {
    const checked = eeroSelectedDevices.has(d.mac) ? 'checked' : '';
    const dot = d.online ? 'online' : 'offline';
    const isThisDevice = !!d.self;
    const flags = [
      isThisDevice ? '<span class="eero-tag this-device" title="The host running gombwe">this device</span>' : '',
      d.blocked ? '<span class="eero-tag blocked">blocked</span>' : '',
      d.owner ? `<span class="eero-tag profile">${esc(d.owner)}</span>` : '',
      d.kid ? '<span class="eero-tag guest">kid</span>' : '',
    ].filter(Boolean).join(' ');

    // Identity bits: prefer mDNS friendly model, fall back to vendor
    const modelOrVendor = d.model_friendly
      ? ` · ${esc(d.model_friendly)}`
      : (d.vendor && d.vendor !== 'Unknown' && d.vendor !== 'Randomized' ? ` · ${esc(d.vendor)}` : '');
    const apInfo = d.ap
      ? ` · ${esc(d.ap.connection_type || 'wireless')}${d.ap.signal_strength ? ' · ' + esc(d.ap.signal_strength) : ''}`
      : '';

    // Owner select needs the currently-selected value marked
    const ownerSelect = ownerOpts.replace(
      `value="${esc(d.owner || '')}"`,
      `value="${esc(d.owner || '')}" selected`,
    );

    const isExpanded = expandedDevices.has(d.mac);
    return `
      <div class="eero-device ${dot}${isThisDevice ? ' this-device' : ''}${isExpanded ? ' is-expanded' : ''}">
        <input type="checkbox" class="eero-device-check" data-mac="${esc(d.mac)}" ${checked}>
        <div class="eero-device-status ${dot}" title="${dot}"></div>
        <div class="eero-device-main" data-act="toggle" data-mac="${esc(d.mac)}" title="Click for details">
          <div class="eero-device-name">
            <span contenteditable="true" data-act="rename" data-mac="${esc(d.mac)}">${esc(d.name || d.hostname || '(unknown)')}</span>
            ${flags}
          </div>
          <div class="eero-device-meta muted small">
            ${esc(d.mac || '')} · ${esc(d.ip || '')}${modelOrVendor}${apInfo}
            ${d.last_seen ? ' · last seen ' + timeAgo(d.last_seen) : ''}
          </div>
        </div>
        <div class="eero-device-actions">
          <select data-act="owner" data-mac="${esc(d.mac)}">${ownerSelect}</select>
          <button class="btn-sm" data-act="pause" data-mac="${esc(d.mac)}" data-on="${d.blocked ? '1' : '0'}">${d.blocked ? 'Unpause' : 'Pause'}</button>
          <select data-act="pause-for" data-mac="${esc(d.mac)}" data-name="${esc(d.name || d.hostname || d.mac)}" title="Pause for…">
            <option value="">Pause for…</option>
            <option value="15">15 min</option>
            <option value="60">1 hour</option>
            <option value="240">4 hours</option>
            <option value="bedtime">Until 7am</option>
          </select>
          <button class="btn-sm" data-act="block" data-mac="${esc(d.mac)}" data-on="${d.blocked ? '1' : '0'}">${d.blocked ? 'Unblock' : 'Block'}</button>
        </div>
        ${isExpanded ? renderDeviceDetail(d) : ''}
      </div>
    `;
  }).join('');

  // ── Action handlers — all hit /api/network/* (MikroTik enforcement) ──

  list.querySelectorAll('.eero-device-check').forEach(c => {
    c.onchange = () => {
      if (c.checked) eeroSelectedDevices.add(c.dataset.mac);
      else eeroSelectedDevices.delete(c.dataset.mac);
      renderEeroBulkBar();
    };
  });

  // Click row body (main area) to toggle the detail panel
  list.querySelectorAll('[data-act="toggle"]').forEach(el => {
    el.onclick = (e) => {
      // Don't toggle when clicking the contenteditable name span (it's an input)
      if (e.target.closest('[data-act="rename"]')) return;
      const mac = el.dataset.mac;
      const d = (networkState.devices || []).find(x => x.mac === mac);
      if (!d) return;
      if (expandedDevices.has(mac)) {
        expandedDevices.delete(mac);
      } else {
        expandedDevices.add(mac);
      }
      renderEeroDevices();
      // If now expanded, async-load DNS history
      if (expandedDevices.has(mac) && d.ip) {
        loadDeviceDnsHistory(mac, d.ip);
      }
    };
  });

  list.querySelectorAll('[data-act="rename"]').forEach(span => {
    span.onblur = async () => {
      const name = span.textContent.trim();
      const mac = span.dataset.mac;
      if (!name || !mac) return;
      try {
        await fetch(`${API}/api/network/devices/${encodeURIComponent(mac)}/name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        refreshDevicesPanel();
      } catch (err) { console.warn('rename failed:', err.message); }
    };
    span.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } };
  });

  list.querySelectorAll('[data-act="owner"]').forEach(sel => {
    sel.onchange = async () => {
      const mac = sel.dataset.mac;
      const owner = sel.value || null;
      try {
        await fetch(`${API}/api/network/devices/${encodeURIComponent(mac)}/owner`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner }),
        });
        refreshDevicesPanel();
      } catch (err) { console.warn('owner change failed:', err.message); }
    };
  });

  // MikroTik has one enforcement primitive: block (optionally with expiry).
  // The eero UI distinguished "pause" (temporary) from "block" (permanent);
  // we map both onto the same /block toggle — instantaneous via conntrack-kill.
  const toggleBlock = async (mac, currentlyBlocked, durationMinutes) => {
    try {
      if (currentlyBlocked) {
        await fetch(`${API}/api/network/devices/${encodeURIComponent(mac)}/unblock`, { method: 'POST' });
      } else {
        const body = durationMinutes ? JSON.stringify({ duration_minutes: durationMinutes }) : '{}';
        await fetch(`${API}/api/network/devices/${encodeURIComponent(mac)}/block`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      }
      refreshDevicesPanel();
    } catch (err) { console.warn('block toggle failed:', err.message); }
  };

  list.querySelectorAll('[data-act="pause"]').forEach(b => {
    b.onclick = () => toggleBlock(b.dataset.mac, b.dataset.on === '1');
  });

  list.querySelectorAll('[data-act="block"]').forEach(b => {
    b.onclick = () => toggleBlock(b.dataset.mac, b.dataset.on === '1');
  });

  list.querySelectorAll('[data-act="pause-for"]').forEach(sel => {
    sel.onchange = async () => {
      if (!sel.value) return;
      let minutes;
      if (sel.value === 'bedtime') {
        const now = new Date();
        const seven = new Date(now);
        seven.setHours(7, 0, 0, 0);
        if (seven <= now) seven.setDate(seven.getDate() + 1);
        minutes = Math.round((seven - now) / 60000);
      } else {
        minutes = Number(sel.value);
      }
      await toggleBlock(sel.dataset.mac, false, minutes);
      sel.value = '';
    };
  });

  renderEeroBulkBar();
}

function renderEeroBulkBar() {
  const bar = document.getElementById('eeroBulkBar');
  document.getElementById('eeroBulkCount').textContent = `${eeroSelectedDevices.size} selected`;
  bar.classList.toggle('hidden', eeroSelectedDevices.size === 0);
}

// Profiles subtab — MikroTik-driven, derived from owner attribution +
// family.members. A "profile" is a person who owns one or more devices.
// "Unassigned" is a synthetic profile for devices with no owner yet.
//
// All actions fan out to /api/network/devices/:mac/{block,unblock,owner,kid}.
// Eero profiles (which don't enforce anything in bridged mode) are no longer
// read or written.

const expandedProfiles = new Set();

function renderEeroProfiles() {
  const list = document.getElementById('eeroProfileList');
  if (!list) return;

  // Group devices by owner. Unassigned bucket holds those with no owner.
  const byOwner = new Map();
  const unassigned = [];
  for (const d of (networkState.devices || [])) {
    if (d.owner) {
      if (!byOwner.has(d.owner)) byOwner.set(d.owner, []);
      byOwner.get(d.owner).push(d);
    } else {
      unassigned.push(d);
    }
  }
  // Include family.members with zero devices so newly-added people show up
  for (const m of (familyData.members || [])) {
    if (m.name && !byOwner.has(m.name)) byOwner.set(m.name, []);
  }

  const profileNames = [...byOwner.keys()].sort();
  if (profileNames.length === 0 && unassigned.length === 0) {
    list.innerHTML = '<div class="muted small" style="padding:16px">No profiles or devices yet. Assign an owner from the Devices subtab to create a profile.</div>';
    return;
  }

  const renderProfileCard = (name, devices) => {
    const expanded = expandedProfiles.has(name);
    const online = devices.filter(d => d.online).length;
    const blocked = devices.filter(d => d.blocked).length;
    const anyKid = devices.some(d => d.kid);
    const totalBytes = devices.reduce((s, d) => s + (d.today_bytes_down || 0) + (d.today_bytes_up || 0), 0);

    const allDevices = networkState.devices || [];
    const subline = `${devices.length} device${devices.length !== 1 ? 's' : ''} · ${online} online${blocked ? ` · ${blocked} blocked` : ''} · ${formatBytes(totalBytes)} today${anyKid ? ' · KID' : ''}`;

    return `
      <div class="eero-profile-card">
        <div class="eero-profile-row">
          <div>
            <div class="eero-profile-name">${esc(name)}</div>
            <div class="muted small">${subline}</div>
          </div>
          <div class="eero-profile-actions">
            <button class="btn-sm" data-act="profile-toggle" data-profile="${esc(name)}">${expanded ? 'Hide devices' : 'Manage devices'}</button>
            <button class="btn-sm" data-act="profile-pause-all" data-profile="${esc(name)}" ${devices.length === 0 ? 'disabled' : ''}>Pause all</button>
            <button class="btn-sm" data-act="profile-unpause-all" data-profile="${esc(name)}" ${blocked === 0 ? 'disabled' : ''}>Unpause all</button>
            <button class="btn-sm" data-act="profile-kid-toggle" data-profile="${esc(name)}" data-on="${anyKid ? '1' : '0'}" ${devices.length === 0 ? 'disabled' : ''}>${anyKid ? 'Unmark kid' : 'Mark as kid'}</button>
          </div>
        </div>
        ${expanded ? `
          <div class="eero-profile-devices">
            <div class="muted small">Tick devices to include in <strong>${esc(name)}</strong>. Save fans out per-device owner changes.</div>
            ${allDevices.map(d => {
              const inProfile = d.owner === name;
              const otherOwner = d.owner && d.owner !== name ? d.owner : '';
              return `
                <label class="eero-profile-device">
                  <input type="checkbox" data-pdev="${esc(d.mac)}" data-profile="${esc(name)}" ${inProfile ? 'checked' : ''}>
                  <span class="eero-profile-device-name">${esc(d.name || d.hostname || d.mac)}</span>
                  <span class="muted small">${esc(d.mac || '')}${otherOwner ? ` · currently in <em>${esc(otherOwner)}</em>` : ''}</span>
                </label>
              `;
            }).join('')}
            <div class="form-row">
              <button class="btn-primary btn-sm" data-act="profile-save" data-profile="${esc(name)}">Save device list</button>
              <span class="muted small">A device has one owner. Adding it here removes it from any other profile.</span>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  };

  let html = profileNames.map(n => renderProfileCard(n, byOwner.get(n))).join('');
  if (unassigned.length) {
    html += `
      <div class="eero-profile-card unassigned">
        <div class="eero-profile-row">
          <div>
            <div class="eero-profile-name muted">Unassigned</div>
            <div class="muted small">${unassigned.length} device${unassigned.length !== 1 ? 's' : ''} with no owner — assign them from the Devices subtab or below</div>
          </div>
        </div>
        <div class="eero-profile-devices">
          ${unassigned.map(d => `
            <div class="eero-profile-device">
              <span class="eero-profile-device-name">${esc(d.name || d.hostname || d.mac)}</span>
              <span class="muted small">${esc(d.mac)} · ${esc(d.vendor || '')}${d.kid ? ' · kid' : ''}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  list.innerHTML = html;

  // Expand / collapse
  list.querySelectorAll('[data-act="profile-toggle"]').forEach(b => {
    b.onclick = () => {
      const n = b.dataset.profile;
      if (expandedProfiles.has(n)) expandedProfiles.delete(n);
      else expandedProfiles.add(n);
      renderEeroProfiles();
    };
  });

  const refresh = async () => { await loadNetworkDevices(); renderEeroProfiles(); };

  // Pause all — fan out /block per MAC in this profile
  list.querySelectorAll('[data-act="profile-pause-all"]').forEach(b => {
    b.onclick = async () => {
      const macs = (byOwner.get(b.dataset.profile) || []).filter(d => !d.blocked).map(d => d.mac);
      if (macs.length === 0) return;
      if (!confirm(`Pause ${macs.length} device${macs.length !== 1 ? 's' : ''} owned by ${b.dataset.profile}?`)) return;
      await Promise.all(macs.map(m => fetch(`${API}/api/network/devices/${encodeURIComponent(m)}/block`, { method: 'POST' })));
      refresh();
    };
  });

  // Unpause all — fan out /unblock per MAC currently blocked
  list.querySelectorAll('[data-act="profile-unpause-all"]').forEach(b => {
    b.onclick = async () => {
      const macs = (byOwner.get(b.dataset.profile) || []).filter(d => d.blocked).map(d => d.mac);
      if (macs.length === 0) return;
      await Promise.all(macs.map(m => fetch(`${API}/api/network/devices/${encodeURIComponent(m)}/unblock`, { method: 'POST' })));
      refresh();
    };
  });

  // Kid toggle — set/clear kid on every device in this profile
  list.querySelectorAll('[data-act="profile-kid-toggle"]').forEach(b => {
    b.onclick = async () => {
      const turnOn = b.dataset.on !== '1';
      const macs = (byOwner.get(b.dataset.profile) || []).map(d => d.mac);
      await Promise.all(macs.map(m =>
        fetch(`${API}/api/network/devices/${encodeURIComponent(m)}/kid`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: turnOn }),
        })));
      refresh();
    };
  });

  // Save device list — per-checkbox: assign-to-this-profile if checked but
  // current owner != name; unassign if unchecked but current owner == name
  list.querySelectorAll('[data-act="profile-save"]').forEach(b => {
    b.onclick = async () => {
      const profile = b.dataset.profile;
      const checks = Array.from(list.querySelectorAll(`input[data-profile="${profile}"]`));
      const ops = [];
      for (const c of checks) {
        const mac = c.dataset.pdev;
        const d = (networkState.devices || []).find(x => x.mac === mac);
        if (!d) continue;
        if (c.checked && d.owner !== profile) {
          ops.push({ mac, owner: profile });
        } else if (!c.checked && d.owner === profile) {
          ops.push({ mac, owner: null });
        }
      }
      if (ops.length === 0) return;
      b.disabled = true; b.textContent = 'Saving…';
      try {
        for (const op of ops) {
          await fetch(`${API}/api/network/devices/${encodeURIComponent(op.mac)}/owner`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner: op.owner }),
          });
        }
        showEeroToast(`Updated ${ops.length} device${ops.length !== 1 ? 's' : ''}`);
        refresh();
      } catch (err) { alert(err.message); }
      finally { b.disabled = false; b.textContent = 'Save device list'; }
    };
  });
}

// Usage subtab — MikroTik-driven. Daily stacked-area chart by app category
// from /api/network/history, with target dropdown to filter by household /
// person / device. Ported from the trend chart in /ui/network.html.
//
// eero's data_usage endpoint required eero Plus and only gave network-wide
// totals; this version gives per-category breakdown across the household,
// per person, or per device — sourced from the daily history rollups our
// snapshot collector + DNS log already produce.

const CATEGORY_COLORS = {
  video:        '#1F6E8C',
  social:       '#E15A2A',
  messaging:    '#3B5BB6',
  gaming:       '#2E7D32',
  music:        '#C7A24A',
  productivity: '#506A8A',
  shopping:     '#B8467A',
  news:         '#8B5E3C',
  system:       '#B5B5B5',
  ads:          '#8E8E8E',
  adult:        '#C13030',
  gambling:     '#E08B2A',
  dangerous:    '#7A1F1F',
  unknown:      '#D6D6D6',
};
const CATEGORY_ORDER = [
  'video','social','messaging','gaming','music',
  'productivity','shopping','news','system','ads',
  'adult','gambling','dangerous','unknown',
];

function categoryTotalsForDay(day) {
  const out = {};
  for (const dev of (day.devices || [])) {
    const cats = dev.categories || {};
    for (const k of Object.keys(cats)) out[k] = (out[k] || 0) + cats[k];
  }
  return out;
}

function shortBytes(n) {
  if (!n || n < 1024) return `${Math.round(n || 0)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function drawUsageStackedArea(svg, days) {
  svg.innerHTML = '';
  if (days.length === 0) return;
  const ns = 'http://www.w3.org/2000/svg';
  const W = 800, H = 240, padL = 56, padR = 8, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = days.length;

  const stacks = days.map(categoryTotalsForDay);
  let maxTotal = 0;
  for (const s of stacks) {
    let t = 0;
    for (const k of Object.keys(s)) t += s[k];
    if (t > maxTotal) maxTotal = t;
  }
  if (maxTotal === 0) {
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', W / 2); text.setAttribute('y', H / 2);
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('class', 'chart-empty-text');
    text.textContent = 'No traffic recorded in this range';
    svg.appendChild(text);
    return;
  }

  const xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / maxTotal) * plotH;

  // Gridlines + Y labels
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', y);    line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-gridline');
    svg.appendChild(line);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', padL - 6); label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'chart-axis-label');
    label.textContent = shortBytes(maxTotal * (1 - g / 4));
    svg.appendChild(label);
  }

  // Stack bands bottom-up so important categories sit on top visually
  const bottom = new Array(n).fill(0);
  for (let ci = CATEGORY_ORDER.length - 1; ci >= 0; ci--) {
    const cat = CATEGORY_ORDER[ci];
    const colour = CATEGORY_COLORS[cat] || '#CCC';
    let hasAny = false, top = '', bot = '';
    for (let i = 0; i < n; i++) {
      const v = stacks[i][cat] || 0;
      if (v > 0) hasAny = true;
      top += `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(bottom[i] + v)} `;
      bot = `L ${xAt(i)} ${yAt(bottom[i])} ` + bot;
    }
    if (!hasAny) continue;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', top + bot + 'Z');
    path.setAttribute('fill', colour);
    path.setAttribute('fill-opacity', '0.85');
    path.setAttribute('class', 'chart-band');
    path.setAttribute('data-category', cat);
    svg.appendChild(path);
    for (let i = 0; i < n; i++) bottom[i] += stacks[i][cat] || 0;
  }

  // X-axis date labels (first, middle, last)
  const labelIdx = n <= 3 ? days.map((_, i) => i) : [0, Math.floor(n / 2), n - 1];
  for (const i of labelIdx) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', xAt(i)); t.setAttribute('y', H - 8);
    t.setAttribute('text-anchor', i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
    t.setAttribute('class', 'chart-axis-label');
    const d = new Date(days[i].date + 'T00:00:00');
    t.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(t);
  }
}

function drawUsageLegend(container, days) {
  const seen = new Set();
  for (const day of days) {
    const totals = categoryTotalsForDay(day);
    for (const k of Object.keys(totals)) if (totals[k] > 0) seen.add(k);
  }
  container.innerHTML = CATEGORY_ORDER.filter(c => seen.has(c))
    .map(c => `<span class="legend-item"><span class="legend-swatch" style="background:${CATEGORY_COLORS[c]}"></span>${esc(c)}</span>`)
    .join('');
}

function populateUsageTargetDropdown() {
  const sel = document.getElementById('eeroUsageTarget');
  if (!sel) return;
  // Preserve current selection across re-population
  const prev = sel.value;
  const owners = new Set();
  const devices = [];
  for (const d of (networkState.devices || [])) {
    if (d.owner) owners.add(d.owner);
    devices.push({ mac: d.mac, name: d.name || d.hostname || d.mac });
  }
  for (const m of (familyData.members || [])) if (m.name) owners.add(m.name);
  let html = '<option value="">All household</option>';
  if (owners.size) {
    html += '<optgroup label="People">' +
      [...owners].sort().map(o => `<option value="owner:${esc(o)}">${esc(o)}</option>`).join('') +
      '</optgroup>';
  }
  if (devices.length) {
    html += '<optgroup label="Devices">' +
      devices.sort((a, b) => a.name.localeCompare(b.name))
        .map(d => `<option value="mac:${esc(d.mac)}">${esc(d.name)}</option>`).join('') +
      '</optgroup>';
  }
  sel.innerHTML = html;
  if (prev) sel.value = prev;
}

// Per-device session dossier — every connection the NetFlow collector recorded,
// rolled up per device with its top destinations (bytes / sessions / duration).
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtDur(s) {
  s = Number(s) || 0;
  if (s >= 3600) return (s / 3600).toFixed(1) + 'h';
  if (s >= 60) return Math.round(s / 60) + 'm';
  return Math.round(s) + 's';
}
async function renderUsageDossier() {
  const box = document.getElementById('usageDossier');
  if (!box) return;
  const days = document.getElementById('eeroUsageRange')?.value || '7';
  box.innerHTML = '<div class="muted small" style="padding:16px">Loading session dossier…</div>';
  let d;
  try {
    const res = await fetch(`${API}/api/network/usage?days=${encodeURIComponent(days)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    d = await res.json();
  } catch (err) {
    box.innerHTML = `<div class="muted small" style="padding:16px">Couldn't load dossier: ${esc(err.message)}</div>`;
    return;
  }
  if (!d.devices || !d.devices.length) {
    box.innerHTML = '<div class="muted small" style="padding:16px">No sessions recorded yet. The NetFlow collector logs connections as they expire (~1 min).</div>';
    return;
  }
  const flagIcon = (sev) => sev === 'high' ? '🚩' : (sev === 'med' || sev === 'medium') ? '⚠️' : sev === 'low' ? '⚑' : '';
  const tspan = (t) => `<span title="${esc(t)}">${esc((t || '').slice(5, 16).replace('T', ' '))}</span>`;
  const rows = d.devices.map(dev => {
    const flaggedCount = dev.destinations.filter(t => t.flagged).length;
    const audit = dev.auditFlags || 0;
    const showFlag = flaggedCount || audit;
    return `
    <details class="dossier-device">
      <summary>
        <span class="dossier-name">${showFlag ? '🚩 ' : ''}${esc(dev.name || dev.ip)}</span>
        <span class="dossier-meta">↓${fmtBytes(dev.bytesDown)} ↑${fmtBytes(dev.bytesUp)} · ${dev.sessions.toLocaleString()} sessions · ${tspan(dev.firstSeen)}–${tspan(dev.lastSeen)}${audit ? ` · <span class="flag-text">${audit} in audit</span>` : ''}</span>
      </summary>
      <table class="eero-table audit-table">
        <thead><tr><th>Destination</th><th>↓ Down</th><th>↑ Up</th><th>Sessions</th><th>Active time</th><th>First seen</th><th>Last seen</th></tr></thead>
        <tbody>
          ${dev.destinations.map(t => `
            <tr class="${t.flagged ? 'dossier-flagged' : ''}">
              <td>${t.flagged ? `<span class="flag-text" title="flagged (${esc(t.flagged)}) — in audit">${flagIcon(t.flagged)}</span> ` : ''}${t.host ? `${esc(t.host)} <span class="muted small">${esc(t.remote)}</span>` : `<code>${esc(t.remote)}</code>`}</td>
              <td>${fmtBytes(t.bytesDown)}</td>
              <td>${fmtBytes(t.bytesUp)}</td>
              <td>${t.sessions}</td>
              <td>${fmtDur(t.dur_s)}</td>
              <td>${tspan(t.firstSeen)}</td>
              <td>${tspan(t.lastSeen)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </details>`; }).join('');
  box.innerHTML = `
    <div class="eero-card-header">
      <span>Session dossier — per device (last ${esc(String(d.days))}d)</span>
      <span class="muted small">source: ${esc(d.source)} · 🚩/⚠️ = destination also flagged in Audit</span>
    </div>
    ${rows}`;
}

// ════════════════════════════════════════════════════════════════════
//  ACTIVITY — per-device online behaviour log (what / when / category).
//  Answers "precisely what is this child doing online", from DNS history.
// ════════════════════════════════════════════════════════════════════
const ACT_COLOURS = { adult:'#ff3b54','proxy/vpn':'#ff7a3b','ai-helper':'#ffb454',gambling:'#ff3b54','dating/strangers':'#ff3b54',social:'#9d8cff',gaming:'#7cf86a',video:'#4ad6ff',search:'#8aa0c8',other:'#5b6b86' };
const activity = { days:7, mac:'', flaggedOnly:false, filter:'', devices:[] };

async function startActivity() {
  try {
    const devs = await (await fetch(`${API}/api/network/devices`)).json();
    activity.devices = (devs||[]).filter(d=>d.mac).map(d=>({mac:d.mac, name:d.name||d.hostname||d.ip||d.mac}))
      .sort((a,b)=>a.name.localeCompare(b.name));
  } catch { activity.devices = []; }
  const sel = document.getElementById('actDevice');
  if (sel) {
    sel.innerHTML = activity.devices.map(d=>`<option value="${esc(d.mac)}">${esc(d.name)}</option>`).join('');
    if (!activity.mac) {
      const liam = activity.devices.find(d=>/liam.*chrome/i.test(d.name)) || activity.devices.find(d=>/liam/i.test(d.name));
      activity.mac = (liam||activity.devices[0]||{}).mac || '';
    }
    sel.value = activity.mac;
    sel.onchange = () => { activity.mac = sel.value; renderActivity(); };
  }
  const dd=document.getElementById('actDays'); if(dd) dd.onchange = e => { activity.days = +e.target.value; renderActivity(); };
  const fl=document.getElementById('actFlagged'); if(fl) fl.onchange = e => { activity.flaggedOnly = e.target.checked; renderActivity(); };
  const ft=document.getElementById('actFilter'); if(ft) ft.oninput = e => { activity.filter = e.target.value.toLowerCase(); renderActivity(); };
  renderActivity();
}
function stopActivity() { /* no polling — historical view, loads on demand */ }

async function renderActivity() {
  const box = document.getElementById('actLog');
  if (!box) return;
  if (!activity.mac) { box.innerHTML = '<div class="sc-empty">No device selected.</div>'; return; }
  box.innerHTML = '<div class="sc-empty">Reading activity…</div>';
  let d;
  try {
    d = await (await fetch(`${API}/api/network/activity?mac=${encodeURIComponent(activity.mac)}&days=${activity.days}&flaggedOnly=${activity.flaggedOnly}`)).json();
  } catch (e) { box.innerHTML = `<div class="sc-empty">Couldn't load: ${esc(e.message)}</div>`; return; }
  const f = activity.filter;
  const rows = (d.visits||[]).filter(v => !f || v.domain.includes(f) || v.category.includes(f));
  const cnt = document.getElementById('actCount');
  if (cnt) cnt.textContent = `${d.totalVisits} visits · ${d.concerning} flagged · ${d.days}d`;
  if (!rows.length) { box.innerHTML = '<div class="sc-empty">No matching activity in this window.</div>'; return; }
  const when = t => new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const hm = t => new Date(t).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  box.innerHTML = `
    <table class="strands-table act-table">
      <thead><tr><th>When</th><th>Site</th><th>Category</th><th class="num">↓ Down</th><th class="num">↑ Up</th><th class="num">Lookups</th></tr></thead>
      <tbody>
        ${rows.map(v => {
          const col = ACT_COLOURS[v.category] || '#5b6b86';
          const win = v.first !== v.last ? `<span class="sc-ip">${when(v.first)} – ${hm(v.last)}</span>` : '';
          const vol = b => b > 0 ? fmtBytes(b) : '<span class="dim">—</span>';
          return `<tr class="${(v.concern||v.inAudit)?'sc-flagged':''}">
            <td class="mono dim act-when">${when(v.last)}</td>
            <td class="sc-dst"><span class="sc-host">${esc(v.domain)}</span>${win}</td>
            <td><span class="act-cat" style="color:${col};border-color:${col}55">${esc(v.category)}</span>${v.inAudit?' <span class="sc-flag" title="recorded in audit">🚩</span>':''}</td>
            <td class="mono num">${vol(v.down)}</td>
            <td class="mono num">${vol(v.up)}</td>
            <td class="mono num dim">${v.count}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function renderEeroUsageChart() {
  const chart = document.getElementById('eeroUsageChart');
  const legend = document.getElementById('eeroUsageLegend');
  const totals = document.getElementById('eeroUsageTotals');
  if (!chart) return;

  populateUsageTargetDropdown();

  const days = Number(document.getElementById('eeroUsageRange')?.value || 30);
  const target = document.getElementById('eeroUsageTarget')?.value || '';

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  let filter = '';
  if (target.startsWith('owner:')) filter = `&owner=${encodeURIComponent(target.slice(6))}`;
  else if (target.startsWith('mac:')) filter = `&mac=${encodeURIComponent(target.slice(4))}`;

  chart.innerHTML = '';
  if (legend) legend.innerHTML = '';
  if (totals) totals.textContent = 'Loading…';

  try {
    const res = await fetch(`${API}/api/network/history?from=${from}&to=${to}${filter}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const ds = payload.days || [];
    const totalBytes = ds.reduce((s, d) => s + (d.total_bytes || 0), 0);
    const totalQueries = ds.reduce((s, d) => s + (d.total_queries || 0), 0);
    if (totals) totals.textContent = `${formatBytes(totalBytes)} · ${totalQueries.toLocaleString()} DNS queries · ${ds.length} days`;
    drawUsageStackedArea(chart, ds);
    if (legend) drawUsageLegend(legend, ds);
  } catch (err) {
    if (totals) totals.textContent = `Error: ${err.message}`;
    chart.innerHTML = `<text x="400" y="120" text-anchor="middle" class="chart-empty-text">Couldn't load history: ${esc(err.message)}</text>`;
  }
}

// MikroTik-driven Speed subtab (step 7). Polls /api/network/interfaces.
// Browser-side ring buffer accumulates WAN throughput samples for a live
// sparkline — no server-side sampler needed for a first cut. The buffer
// resets if you close the tab; that's acceptable, history isn't durable.
const SPEED_WAN_IFACE = 'ether1';  // RouterOS convention; tweak if your WAN port differs
const SPEED_RING_CAP = 120;        // ~10 min at 5s polling
let speedRing = [];                // [{ t: ms, down_mbps, up_mbps }]
let speedPollTimer = null;

async function renderEeroSpeed() {
  const statsEl = document.getElementById('speedStats');
  const chartEl = document.getElementById('speedChart');
  const tableEl = document.getElementById('speedTable');
  if (!statsEl || !chartEl || !tableEl) return;

  let ifaces;
  try {
    const res = await fetch(`${API}/api/network/interfaces`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ifaces = await res.json();
  } catch (err) {
    statsEl.innerHTML = `<div class="muted small">Interfaces unavailable: ${esc(err.message)}</div>`;
    chartEl.innerHTML = '';
    tableEl.innerHTML = '';
    return;
  }

  // Locate the WAN interface; tolerate naming variation by falling back to
  // the first non-loopback running interface.
  const wan = ifaces.find(i => i.name === SPEED_WAN_IFACE)
            ?? ifaces.find(i => i.running === 'true' && i.type !== 'loopback');
  const downMbps = wan ? bitsToMbps(wan['rx-bits-per-second']) : 0;
  const upMbps   = wan ? bitsToMbps(wan['tx-bits-per-second']) : 0;
  const totalRx = ifaces.reduce((s, i) => s + (parseInt(i['rx-byte'] || '0') || 0), 0);
  const totalTx = ifaces.reduce((s, i) => s + (parseInt(i['tx-byte'] || '0') || 0), 0);
  const errors = ifaces.reduce((s, i) => s + (parseInt(i['rx-error'] || '0') || 0) + (parseInt(i['tx-error'] || '0') || 0), 0);

  statsEl.innerHTML = `
    ${eeroStat('WAN down', `${downMbps.toFixed(1)} Mbps`, wan?.name || '—')}
    ${eeroStat('WAN up', `${upMbps.toFixed(1)} Mbps`, wan?.name || '—')}
    ${eeroStat('Total received', formatBytes(totalRx), 'all interfaces, since boot')}
    ${eeroStat('Total sent', formatBytes(totalTx), 'all interfaces, since boot')}
    ${eeroStat('Interfaces', String(ifaces.length), `${ifaces.filter(i => i.running === 'true').length} running`)}
    ${eeroStat('Errors', String(errors), 'rx + tx, all interfaces')}
  `;

  // Append to ring buffer + redraw chart.
  speedRing.push({ t: Date.now(), down_mbps: downMbps, up_mbps: upMbps });
  if (speedRing.length > SPEED_RING_CAP) speedRing.shift();
  const meta = document.getElementById('speedChartMeta');
  if (meta) meta.textContent = `${speedRing.length} samples · last ${Math.round((speedRing[speedRing.length-1].t - speedRing[0].t) / 1000)}s`;
  if (speedRing.length < 2) {
    chartEl.innerHTML = '<div class="muted small">Collecting samples… open this tab for a minute.</div>';
  } else {
    chartEl.innerHTML = speedThroughputChart(speedRing);
  }

  // Interfaces table — running first, by name.
  const sorted = ifaces.slice().sort((a, b) => {
    const ar = a.running === 'true', br = b.running === 'true';
    if (ar !== br) return ar ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  document.getElementById('speedTableMeta').textContent = `${sorted.length} interfaces`;
  tableEl.innerHTML = `
    <table class="eero-table">
      <thead><tr><th>Name</th><th>Type</th><th>State</th><th>↓ Mbps</th><th>↑ Mbps</th><th>RX</th><th>TX</th><th>Errors</th></tr></thead>
      <tbody>
        ${sorted.map(i => {
          const dl = bitsToMbps(i['rx-bits-per-second']);
          const ul = bitsToMbps(i['tx-bits-per-second']);
          const err = (parseInt(i['rx-error'] || '0') || 0) + (parseInt(i['tx-error'] || '0') || 0);
          const drop = (parseInt(i['rx-drop'] || '0') || 0) + (parseInt(i['tx-drop'] || '0') || 0);
          return `
            <tr>
              <td><code>${esc(i.name || '—')}</code></td>
              <td class="muted small">${esc(i.type || '')}</td>
              <td>${i.running === 'true' ? '<span class="speed-state up">up</span>' : '<span class="speed-state down">down</span>'}</td>
              <td class="speed-num">${dl.toFixed(2)}</td>
              <td class="speed-num">${ul.toFixed(2)}</td>
              <td class="speed-num">${formatBytes(parseInt(i['rx-byte'] || '0') || 0)}</td>
              <td class="speed-num">${formatBytes(parseInt(i['tx-byte'] || '0') || 0)}</td>
              <td class="speed-num ${err > 0 ? 'has-errors' : ''}">${err || '—'}${drop > 0 ? ` (+${drop} drop)` : ''}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

function bitsToMbps(s) {
  const n = parseInt(s || '0') || 0;
  return n / 1_000_000;
}

// Calibrated WAN throughput chart — Y gridlines + Mbps tick labels, X time
// labels, inline legend. ymax snaps to a "nice" round value so the scale
// only jumps in user-friendly steps (1, 2, 5, 10, 20, 50, 100, 200, 500, …).
function speedThroughputChart(samples) {
  const w = 600, h = 180;
  const padL = 44, padR = 12, padT = 14, padB = 26;
  const xs = samples.map(s => s.t);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const peak = Math.max(1, ...samples.map(s => Math.max(s.down_mbps, s.up_mbps)));
  const ymax = niceRound(peak);
  const xScale = t => padL + (xmax === xmin ? 0 : ((t - xmin) / (xmax - xmin)) * (w - padL - padR));
  const yScale = v => h - padB - (v / ymax) * (h - padT - padB);

  // 4 horizontal gridlines at 25/50/75/100% of ymax
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ frac: f, val: ymax * f }));
  const gridLines = ticks.map(t => `
    <line x1="${padL}" x2="${w - padR}" y1="${yScale(t.val)}" y2="${yScale(t.val)}" class="speed-grid"/>
    <text x="${padL - 6}" y="${yScale(t.val) + 4}" text-anchor="end" class="speed-tick">${formatMbpsTick(t.val)}</text>
  `).join('');

  // Time labels at start, mid, end
  const elapsed = (xmax - xmin) / 1000;
  const xLabelLeft = formatRelTime(-elapsed);
  const xLabelRight = 'now';
  const xLabelMid = formatRelTime(-elapsed / 2);

  const ptStr = (series, key) => series.map(s => `${xScale(s.t)},${yScale(s[key])}`).join(' ');

  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="speed-svg">
      ${gridLines}
      <polyline class="speed-line down" fill="none" points="${ptStr(samples, 'down_mbps')}"/>
      <polyline class="speed-line up"   fill="none" points="${ptStr(samples, 'up_mbps')}"/>
      <text x="${padL}"            y="${h - 8}" class="speed-tick">${esc(xLabelLeft)}</text>
      <text x="${(padL + w - padR) / 2}" y="${h - 8}" text-anchor="middle" class="speed-tick">${esc(xLabelMid)}</text>
      <text x="${w - padR}"        y="${h - 8}" text-anchor="end" class="speed-tick">${xLabelRight}</text>
      <g class="speed-legend">
        <rect x="${w - 150}" y="2" width="12" height="3" class="speed-line down swatch"/>
        <text x="${w - 134}" y="6" class="speed-tick">down</text>
        <rect x="${w - 80}"  y="2" width="12" height="3" class="speed-line up swatch"/>
        <text x="${w - 64}"  y="6" class="speed-tick">up</text>
      </g>
    </svg>
  `;
}

// Snap a peak value to the next "nice" ceiling — keeps the Y scale from
// jittering with every new sample. Steps in human scale 1,2,5,10,20,50,…
function niceRound(v) {
  const tiers = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  for (const t of tiers) if (v <= t) return t;
  return Math.ceil(v / 1000) * 1000;
}

function formatMbpsTick(v) {
  if (v >= 100) return `${v.toFixed(0)}`;
  if (v >= 10)  return `${v.toFixed(0)}`;
  return v.toFixed(1);
}

function formatRelTime(secondsAgo) {
  const s = Math.round(secondsAgo);
  if (s === 0) return 'now';
  const abs = Math.abs(s);
  if (abs < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

// Auto-poll while the Speed pane is visible. The poller is armed when the
// user activates the subtab and disarmed when they switch away — keeps the
// router load tiny when no one's looking.
function startSpeedPolling() {
  if (speedPollTimer) return;
  renderEeroSpeed();  // immediate first paint
  speedPollTimer = setInterval(renderEeroSpeed, 5000);
}
function stopSpeedPolling() {
  if (speedPollTimer) { clearInterval(speedPollTimer); speedPollTimer = null; }
}

// MikroTik-driven Advanced (step 8). Three sections — port forwards (NAT),
// DHCP reservations (static leases), firewall rules viewer (read-only).
// Function name kept (renderEeroAdvanced) to avoid churning call sites.
async function renderEeroAdvanced() {
  await Promise.all([
    renderAdvPortForwards(),
    renderAdvDhcpLeases(),
    renderAdvFirewall(),
  ]);
}

async function renderAdvPortForwards() {
  const listEl = document.getElementById('advPortForwards');
  const meta = document.getElementById('advPortForwardsMeta');
  if (!listEl) return;
  let rules;
  try {
    rules = await fetch(`${API}/api/network/nat`).then(r => r.ok ? r.json() : []);
  } catch { rules = []; }
  // Only show dstnat rules — those are port forwards. srcnat is router-default masquerade.
  const pf = rules.filter(r => r.action === 'dst-nat');
  if (meta) meta.textContent = `${pf.length} forward${pf.length === 1 ? '' : 's'}`;
  if (pf.length === 0) {
    listEl.innerHTML = '<div class="muted small">No port forwards configured.</div>';
  } else {
    listEl.innerHTML = `
      <table class="eero-table">
        <thead><tr><th>Proto</th><th>WAN port</th><th>→ Internal</th><th>Label</th><th>Bytes</th><th></th></tr></thead>
        <tbody>
          ${pf.map(r => `
            <tr>
              <td><code>${esc((r.protocol || '').toUpperCase())}</code></td>
              <td class="speed-num">${esc(r['dst-port'] || '—')}</td>
              <td><code>${esc(r['to-addresses'] || '?')}:${esc(r['to-ports'] || '?')}</code></td>
              <td class="muted small">${esc((r.comment || '').replace(/^gombwe-pf /, '')) || '—'}</td>
              <td class="speed-num muted small">${esc(r.bytes || '0')}</td>
              <td><button class="btn-sm" data-adv-action="del-nat" data-id="${esc(r['.id'])}">Remove</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  }
}

async function renderAdvDhcpLeases() {
  const listEl = document.getElementById('advDhcpLeases');
  const meta = document.getElementById('advDhcpMeta');
  if (!listEl) return;
  let leases;
  try {
    leases = await fetch(`${API}/api/network/dhcp-leases`).then(r => r.ok ? r.json() : []);
  } catch { leases = []; }
  // Static leases first, then dynamic. Static = dynamic field is "false".
  const sorted = leases.slice().sort((a, b) => {
    const as = a.dynamic === 'false' ? 0 : 1, bs = b.dynamic === 'false' ? 0 : 1;
    if (as !== bs) return as - bs;
    return (a.address || '').localeCompare(b.address || '');
  });
  const staticCount = leases.filter(l => l.dynamic === 'false').length;
  if (meta) meta.textContent = `${staticCount} reserved / ${leases.length} total`;
  if (leases.length === 0) {
    listEl.innerHTML = '<div class="muted small">No DHCP leases.</div>';
    return;
  }
  listEl.innerHTML = `
    <table class="eero-table">
      <thead><tr><th>IP</th><th>MAC</th><th>Hostname</th><th>Type</th><th>Comment</th><th></th></tr></thead>
      <tbody>
        ${sorted.map(l => {
          const isStatic = l.dynamic === 'false';
          return `
            <tr>
              <td><code>${esc(l.address || '—')}</code></td>
              <td><code>${esc((l['mac-address'] || '').toUpperCase())}</code></td>
              <td>${esc(l['host-name'] || '—')}</td>
              <td><span class="speed-state ${isStatic ? 'up' : 'down'}">${isStatic ? 'reserved' : 'dynamic'}</span></td>
              <td class="muted small">${esc(l.comment || '—')}</td>
              <td>
                ${isStatic
                  ? `<button class="btn-sm" data-adv-action="del-lease" data-id="${esc(l['.id'])}">Remove</button>`
                  : `<button class="btn-sm" data-adv-action="reserve-lease" data-id="${esc(l['.id'])}">Reserve</button>`
                }
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function renderAdvFirewall() {
  const listEl = document.getElementById('advFwRules');
  const meta = document.getElementById('advFwMeta');
  if (!listEl) return;
  let rules;
  try {
    rules = await fetch(`${API}/api/network/firewall`).then(r => r.ok ? r.json() : []);
  } catch { rules = []; }
  const gombwe = rules.filter(r => (r.comment || '').startsWith('gombwe'));
  if (meta) meta.textContent = `${rules.length} total · ${gombwe.length} gombwe-managed`;
  if (rules.length === 0) {
    listEl.innerHTML = '<div class="muted small">No firewall rules.</div>';
    return;
  }
  listEl.innerHTML = `
    <table class="eero-table">
      <thead><tr><th>#</th><th>Chain</th><th>Action</th><th>Match</th><th>Comment</th><th>State</th><th>Bytes</th><th></th></tr></thead>
      <tbody>
        ${rules.map((r, idx) => {
          const isGombwe = (r.comment || '').startsWith('gombwe');
          const isDisabled = r.disabled === 'true';
          const match = [
            r['src-mac-address'] && `src-mac=${r['src-mac-address']}`,
            r['src-address'] && `src=${r['src-address']}`,
            r['dst-address'] && `dst=${r['dst-address']}`,
            r['dst-port'] && `dport=${r['dst-port']}`,
            r.protocol && `proto=${r.protocol}`,
          ].filter(Boolean).join(' · ');
          const actions = isGombwe ? `
            <button class="btn-sm" data-adv-action="${isDisabled ? 'enable-fw' : 'disable-fw'}" data-id="${esc(r['.id'])}">${isDisabled ? 'Enable' : 'Disable'}</button>
            <button class="btn-sm" data-adv-action="del-fw" data-id="${esc(r['.id'])}">Remove</button>
          ` : '<span class="muted small">read-only</span>';
          return `
            <tr class="${isGombwe ? 'fw-gombwe' : ''} ${isDisabled ? 'fw-disabled' : ''}">
              <td class="muted small">${idx}</td>
              <td><code>${esc(r.chain || '—')}</code></td>
              <td><code>${esc(r.action || '—')}</code></td>
              <td class="muted small">${esc(match || '—')}</td>
              <td class="muted small">${esc(r.comment || '—')}</td>
              <td><span class="speed-state ${isDisabled ? 'down' : 'up'}">${isDisabled ? 'disabled' : 'active'}</span></td>
              <td class="speed-num muted small">${esc(r.bytes || '0')}</td>
              <td>${actions}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// Delegated action handler for Advanced subtab buttons.
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches('[data-adv-action]')) return;
  const action = t.dataset.advAction;
  const id = t.dataset.id;
  if (!id) return;

  if (action === 'del-nat') {
    if (!confirm('Remove this port forward?')) return;
    try {
      const res = await fetch(`${API}/api/network/nat/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await renderAdvPortForwards();
    } catch (err) { alert(`Failed: ${err.message}`); }
  } else if (action === 'del-lease') {
    if (!confirm('Remove this reserved lease? The device falls back to a dynamic IP.')) return;
    try {
      const res = await fetch(`${API}/api/network/dhcp-leases/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await renderAdvDhcpLeases();
    } catch (err) { alert(`Failed: ${err.message}`); }
  } else if (action === 'reserve-lease') {
    if (!confirm('Reserve this IP for this device permanently?')) return;
    try {
      const res = await fetch(`${API}/api/network/dhcp-leases/${encodeURIComponent(id)}/make-static`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await renderAdvDhcpLeases();
    } catch (err) { alert(`Failed: ${err.message}`); }
  } else if (action === 'disable-fw' || action === 'enable-fw') {
    const disabled = action === 'disable-fw';
    try {
      const res = await fetch(`${API}/api/network/firewall/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      await renderAdvFirewall();
    } catch (err) { alert(`Failed: ${err.message}`); }
  } else if (action === 'del-fw') {
    if (!confirm('Remove this firewall rule? This cannot be undone — the device(s) it covered will no longer be blocked at this IP.')) return;
    try {
      const res = await fetch(`${API}/api/network/firewall/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      await renderAdvFirewall();
    } catch (err) { alert(`Failed: ${err.message}`); }
  }
});

// Add-port-forward form handler.
document.getElementById('advPfAddBtn')?.addEventListener('click', async () => {
  const status = document.getElementById('advPfStatus');
  const body = {
    protocol: document.getElementById('advPfProtocol')?.value || 'tcp',
    srcPort: document.getElementById('advPfSrcPort')?.value,
    dstAddress: document.getElementById('advPfDstAddr')?.value?.trim(),
    dstPort: document.getElementById('advPfDstPort')?.value,
    comment: document.getElementById('advPfComment')?.value?.trim() || '',
  };
  if (!body.srcPort || !body.dstAddress || !body.dstPort) {
    if (status) status.textContent = 'All fields required.';
    return;
  }
  if (status) status.textContent = 'Adding…';
  try {
    const res = await fetch(`${API}/api/network/nat/port-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    ['advPfSrcPort', 'advPfDstAddr', 'advPfDstPort', 'advPfComment'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    if (status) status.textContent = 'Added.';
    await renderAdvPortForwards();
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
  }
});

// Audit subtab — MikroTik-driven policy/action feed.
// Reads /api/network/policy/actions (written by the AI policy scanner +
// manual block/unblock operations). The eero internal action log
// (eeroState.actions) is no longer surfaced; it was a redundant
// representation of state changes that now all go through MikroTik.
//
// Function name kept (renderEeroAudit) to avoid churning every call site
// during the rationalisation — will be renamed in the final cleanup pass.
async function renderEeroAudit() {
  const list = document.getElementById('eeroAuditList');
  if (!list) return;
  list.innerHTML = '<div class="muted small" style="padding:16px">Loading audit…</div>';
  let actions = [];
  try {
    const res = await fetch(`${API}/api/network/policy/actions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    actions = await res.json();
  } catch (err) {
    list.innerHTML = `<div class="muted small" style="padding:16px">Couldn't load audit: ${esc(err.message)}</div>`;
    return;
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    list.innerHTML = '<div class="muted small" style="padding:16px">No actions yet. The policy scanner runs every 10 min; manual blocks/unblocks also land here.</div>';
    return;
  }
  // Newest first
  const sorted = actions.slice().reverse();
  const severityClass = (s) => ({
    high: 'sev-high', med: 'sev-medium', medium: 'sev-medium', low: 'sev-low', info: '',
  })[String(s || '').toLowerCase()] || '';
  // Synthesize a reason line for entries that don't carry one (block / unblock
  // / category-enforcement). The AI policy scanner provides its own reason.
  const reasonFor = (a) => {
    if (a.reason) return a.reason;
    if (a.action === 'blocked-by-category') return `${a.category || 'category'} block · ${a.killed_flows || 0} flow(s) killed`;
    if (a.action === 'policy-changed') return `policy → [${(a.categories_now || []).join(', ') || 'none'}]`;
    if (a.action === 'block') return `manual block${a.expires_at ? ` until ${a.expires_at}` : ' (indefinite)'}`;
    if (a.action === 'unblock') return 'manual unblock';
    if (a.action === 'schedule-block-started') return `schedule "${a.schedule_name || a.schedule_id || '?'}" — window opened`;
    if (a.action === 'schedule-block-ended')   return `schedule "${a.schedule_name || a.schedule_id || '?'}" — window closed`;
    return a.action || '';
  };
  list.innerHTML = `
    <table class="eero-table audit-table">
      <thead><tr><th>When</th><th>Action</th><th>Device</th><th>Severity</th><th>Hostname</th><th>Detail</th></tr></thead>
      <tbody>
        ${sorted.map(a => {
          const when = a.time || a.ts || '';
          return `
            <tr>
              <td><span title="${esc(when)}">${esc(timeAgo(when) || '—')}</span></td>
              <td><code>${esc(a.action || '—')}</code></td>
              <td>${esc(a.name || a.mac || '—')}</td>
              <td><span class="audit-sev ${severityClass(a.severity)}">${esc(a.severity || '—')}</span></td>
              <td><code>${esc(a.hostname || '—')}</code></td>
              <td class="audit-reason">${esc(reasonFor(a))}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── NextDNS (website filtering) ────────────────────────────────────────
// Curated quick-toggle services that map directly to NextDNS service IDs.
// The full NextDNS catalog is hundreds of items; these are the ones a
// parent typically reaches for first.
const NEXTDNS_QUICK_SERVICES = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'snapchat', label: 'Snapchat' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'discord', label: 'Discord' },
  { id: 'roblox', label: 'Roblox' },
  { id: 'fortnite', label: 'Fortnite' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'twitter', label: 'X / Twitter' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'minecraft', label: 'Minecraft' },
  { id: 'steam', label: 'Steam' },
  { id: 'omegle', label: 'Omegle' },
  { id: '4chan', label: '4chan' },
];

const NEXTDNS_QUICK_CATEGORIES = [
  { id: 'porn', label: 'Adult / Porn' },
  { id: 'gambling', label: 'Gambling' },
  { id: 'piracy', label: 'Piracy' },
  { id: 'dating', label: 'Dating' },
  { id: 'social-networks', label: 'All social networks' },
  { id: 'video-streaming', label: 'Video streaming' },
  { id: 'gaming', label: 'Gaming' },
];

let nextdnsState = { config: null, services: [], categories: [], denylist: [], allowlist: [] };

async function loadNextDNS() {
  try {
    const cfg = await (await fetch(`${API}/api/nextdns/config`)).json();
    nextdnsState.config = cfg;
    if (!cfg.configured) { renderNextDNS(); return; }

    const [services, categories, deny, allow] = await Promise.all([
      fetch(`${API}/api/nextdns/services`).then(r => r.json()).catch(() => ({ data: [] })),
      fetch(`${API}/api/nextdns/categories`).then(r => r.json()).catch(() => ({ data: [] })),
      fetch(`${API}/api/nextdns/denylist`).then(r => r.json()).catch(() => ({ data: [] })),
      fetch(`${API}/api/nextdns/allowlist`).then(r => r.json()).catch(() => ({ data: [] })),
    ]);
    nextdnsState.services = services.data || [];
    nextdnsState.categories = categories.data || [];
    nextdnsState.denylist = deny.data || [];
    nextdnsState.allowlist = allow.data || [];
  } catch (err) { console.error('nextdns load failed:', err); }
  renderNextDNS();
}

function renderNextDNS() {
  const statusEl = document.getElementById('dnsStatus');
  const pointStatusEl = document.getElementById('dnsPointStatus');
  if (!statusEl) return;
  const cfg = nextdnsState.config || {};
  if (!cfg.configured) {
    statusEl.textContent = 'not configured — paste your API key in Advanced';
    pointStatusEl.textContent = '';
    return;
  }
  statusEl.innerHTML = `config <code>${esc(cfg.configId)}</code> · ${esc(cfg.profileName || '')}`;

  // Three layers of truth — eero setting, gombwe-host DNS, and live test
  const eeroDns = eeroState.snapshot?.network?.dns || {};
  const customIps = eeroDns.custom?.ips || [];
  const ndIps = cfg.resolverIPs || [];
  const isPointed = ndIps.length > 0 && ndIps.every(ip => customIps.includes(ip));
  const eeroMode = eeroDns.mode || 'automatic';
  const eeroResolvers = eeroMode === 'custom'
    ? customIps.join(', ')
    : (eeroDns.parent?.ips || []).join(', ');

  pointStatusEl.innerHTML = `
    <div class="dns-truth">
      <div class="dns-row">
        <span class="dns-row-label">eero network DNS</span>
        <span class="${isPointed ? 'dns-ok' : 'dns-warn'}">
          ${isPointed ? '✓ NextDNS' : `${esc(eeroMode)} (${esc(eeroResolvers || '—')})`}
        </span>
      </div>
      <div class="dns-row">
        <span class="dns-row-label">test.nextdns.io says</span>
        <span class="dns-test" id="dnsTestResult">checking…</span>
      </div>
    </div>
    ${isPointed ? '' : '<div class="muted small" style="margin-top:6px">eero firmware silently rejects custom DNS PUTs without eero Plus. The button below tries anyway — if it doesn\'t take, set DNS per-device manually or upgrade Plus.</div>'}
  `;
  refreshDnsTestResult();
  renderNextDnsRules();
}

let dnsTestRefreshTimer = null;
async function refreshDnsTestResult() {
  const el = document.getElementById('dnsTestResult');
  if (!el) return;
  el.textContent = 'checking…';
  try {
    const r = await fetch(`${API}/api/nextdns/test`);
    const d = await r.json();
    const status = d.status || 'unknown';
    const cfgId = (eeroState && nextdnsState.config?.configId) || '';
    if (status === 'ok' && (d.profile === cfgId || d.config === cfgId)) {
      el.innerHTML = `<span class="dns-ok">✓ using NextDNS · profile ${esc(d.profile || d.config || '?')}</span>`;
    } else if (status === 'unconfigured') {
      el.innerHTML = `<span class="dns-warn">✗ unconfigured — resolver: ${esc(d.resolver || '?')}</span>`;
    } else if (status === 'unreachable') {
      el.innerHTML = `<span class="dns-warn">⚠ test.nextdns.io unreachable: ${esc(d.error || '')}</span>`;
    } else {
      el.innerHTML = `<span class="dns-warn">${esc(status)} — resolver ${esc(d.resolver || '?')}</span>`;
    }
  } catch (err) {
    el.innerHTML = `<span class="dns-warn">test failed: ${esc(err.message)}</span>`;
  }
}

function startDnsTestPolling() {
  stopDnsTestPolling();
  dnsTestRefreshTimer = setInterval(refreshDnsTestResult, 30000);
}
function stopDnsTestPolling() {
  if (dnsTestRefreshTimer) { clearInterval(dnsTestRefreshTimer); dnsTestRefreshTimer = null; }
}

function renderNextDnsRules() {
  // Quick services as toggle pills
  const activeServices = new Set(nextdnsState.services.map(s => s.id));
  const servicesEl = document.getElementById('kidsFilterServices');
  servicesEl.innerHTML = NEXTDNS_QUICK_SERVICES.map(s => `
    <button class="kids-filter-pill ${activeServices.has(s.id) ? 'on' : ''}" data-act="ndns-svc-toggle" data-id="${esc(s.id)}" data-on="${activeServices.has(s.id) ? '1' : '0'}">${esc(s.label)}</button>
  `).join('');
  servicesEl.querySelectorAll('[data-act="ndns-svc-toggle"]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id, on = b.dataset.on === '1';
      b.disabled = true;
      try {
        if (on) await fetch(`${API}/api/nextdns/services?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        else await fetch(`${API}/api/nextdns/services`, eeroPost({ id }));
        await loadNextDNS();
        showEeroToast(`${on ? 'Unblocked' : 'Blocked'} ${id}`);
      } catch (err) { alert(err.message); }
      finally { b.disabled = false; }
    };
  });

  const activeCats = new Set(nextdnsState.categories.map(c => c.id));
  const catsEl = document.getElementById('kidsFilterCategories');
  catsEl.innerHTML = NEXTDNS_QUICK_CATEGORIES.map(c => `
    <button class="kids-filter-pill ${activeCats.has(c.id) ? 'on' : ''}" data-act="ndns-cat-toggle" data-id="${esc(c.id)}" data-on="${activeCats.has(c.id) ? '1' : '0'}">${esc(c.label)}</button>
  `).join('');
  catsEl.querySelectorAll('[data-act="ndns-cat-toggle"]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id, on = b.dataset.on === '1';
      b.disabled = true;
      try {
        if (on) await fetch(`${API}/api/nextdns/categories?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        else await fetch(`${API}/api/nextdns/categories`, eeroPost({ id }));
        await loadNextDNS();
        showEeroToast(`${on ? 'Unblocked' : 'Blocked'} category: ${id}`);
      } catch (err) { alert(err.message); }
      finally { b.disabled = false; }
    };
  });

  // Custom denylist
  const denyEl = document.getElementById('kidsDenylist');
  denyEl.innerHTML = nextdnsState.denylist.length === 0
    ? '<div class="muted small">No custom domains blocked.</div>'
    : nextdnsState.denylist.map(d => `
      <div class="kids-filter-row">
        <code>${esc(d.id)}</code>
        <button class="btn-sm btn-danger" data-act="ndns-deny-del" data-id="${esc(d.id)}">Remove</button>
      </div>
    `).join('');
  denyEl.querySelectorAll('[data-act="ndns-deny-del"]').forEach(b => {
    b.onclick = async () => {
      await fetch(`${API}/api/nextdns/denylist?domain=${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
      loadNextDNS();
    };
  });

  const allowEl = document.getElementById('kidsAllowlist');
  allowEl.innerHTML = nextdnsState.allowlist.length === 0
    ? '<div class="muted small">No allow-list overrides.</div>'
    : nextdnsState.allowlist.map(d => `
      <div class="kids-filter-row">
        <code>${esc(d.id)}</code>
        <button class="btn-sm" data-act="ndns-allow-del" data-id="${esc(d.id)}">Remove</button>
      </div>
    `).join('');
  allowEl.querySelectorAll('[data-act="ndns-allow-del"]').forEach(b => {
    b.onclick = async () => {
      await fetch(`${API}/api/nextdns/allowlist?domain=${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
      loadNextDNS();
    };
  });
}

// ── kids control ───────────────────────────────────────────────────────
function getKidsProfile() {
  const profiles = eeroState.snapshot?.profiles || [];
  return profiles.find(p => /kid/i.test(p.name)) || profiles.find(p => p.name !== 'Unassigned') || null;
}

// ── Access Control subtab — category management + scanner trigger ──
// Renders the MikroTik category-management UI (visibility layer) and
// surfaces the AI policy scanner. Network-wide adlist subscriptions
// and per-device category enforcement are coming in a follow-up commit.

let acCategoriesData = null;
let acUncatData = null;

let acAdlistData = null;

async function loadAccessControl() {
  try {
    const [cats, uncat, adlist] = await Promise.all([
      fetch(`${API}/api/network/categories`).then(r => r.json()),
      fetch(`${API}/api/network/categories/uncategorized?days=7&limit=40`).then(r => r.json()),
      fetch(`${API}/api/network/adlist`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    acCategoriesData = cats;
    acUncatData = uncat;
    acAdlistData = adlist;
  } catch (err) {
    console.warn('loadAccessControl failed:', err.message);
    acCategoriesData = null; acUncatData = null; acAdlistData = null;
  }
  renderAccessControl();
  renderAdlistCard();
}

function renderAdlistCard() {
  const body = document.getElementById('acAdlistBody');
  const meta = document.getElementById('acAdlistMeta');
  if (!body) return;
  const data = acAdlistData;
  if (!data) {
    body.innerHTML = '<div class="muted small">MikroTik adlist unavailable — needs RouterOS 7.7+.</div>';
    if (meta) meta.textContent = '';
    return;
  }
  const subs = data.subscriptions || [];
  const sources = data.sources || [];
  if (meta) meta.textContent = subs.length ? `${subs.length} subscribed` : 'none subscribed';

  // Subscribed URLs index → for quick "is this source enabled?" check.
  const subbedByUrl = new Map(subs.map(s => [s.url, s]));

  // Group sources by category for display.
  const byCategory = new Map();
  for (const src of sources) {
    if (!byCategory.has(src.category)) byCategory.set(src.category, []);
    byCategory.get(src.category).push(src);
  }
  const catOrder = ['adult', 'gambling', 'dangerous', 'ads', 'social'];
  const cats = catOrder.filter(c => byCategory.has(c));

  const rows = cats.map(cat => {
    const color = (typeof CATEGORY_COLORS !== 'undefined' && CATEGORY_COLORS[cat]) || '#999';
    const list = byCategory.get(cat).map(src => {
      const sub = subbedByUrl.get(src.url);
      const isOn = !!sub;
      return `
        <li class="ac-adlist-row" data-source-id="${esc(src.id)}">
          <label class="ac-adlist-toggle">
            <input type="checkbox" data-ac-adlist-toggle data-source-id="${esc(src.id)}" data-sub-id="${esc(sub?.['.id'] || '')}" ${isOn ? 'checked' : ''}>
            <span class="ac-adlist-label">${esc(src.label)}</span>
          </label>
          <span class="muted small">${src.approx_entries.toLocaleString()} entries · ${esc(src.description)}</span>
        </li>
      `;
    }).join('');
    return `
      <div class="ac-adlist-cat">
        <div class="ac-adlist-cat-header">
          <span class="ac-cat-swatch" style="background:${color}"></span>
          <span class="ac-cat-name">${esc(cat)}</span>
        </div>
        <ul class="ac-adlist-list">${list}</ul>
      </div>
    `;
  }).join('');

  // Any custom subscriptions (URL not matching a known source).
  const customs = subs.filter(s => !s.source);
  const customSection = customs.length ? `
    <div class="ac-adlist-cat">
      <div class="ac-adlist-cat-header"><span class="ac-cat-name">Custom</span></div>
      <ul class="ac-adlist-list">
        ${customs.map(s => `
          <li class="ac-adlist-row ac-adlist-row--custom">
            <span class="ac-adlist-label">${esc(s.comment || s.url)}</span>
            <button type="button" class="btn-sm" data-ac-adlist-remove data-sub-id="${esc(s['.id'])}">Remove</button>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  body.innerHTML = rows + customSection;
}

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.matches('[data-ac-adlist-toggle]')) return;
  const sourceId = t.dataset.sourceId;
  const subId = t.dataset.subId;
  const status = document.getElementById('acAdlistStatus');
  t.disabled = true;
  if (status) status.textContent = t.checked ? 'Subscribing…' : 'Removing…';
  try {
    if (t.checked) {
      const res = await fetch(`${API}/api/network/adlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } else if (subId) {
      const res = await fetch(`${API}/api/network/adlist/${encodeURIComponent(subId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
    if (status) status.textContent = '';
    await loadAccessControl();
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
    t.checked = !t.checked;
  } finally {
    t.disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.matches('[data-ac-adlist-remove]')) {
    const subId = t.dataset.subId;
    if (!subId) return;
    if (!confirm('Remove this subscription?')) return;
    try {
      const res = await fetch(`${API}/api/network/adlist/${encodeURIComponent(subId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadAccessControl();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    }
  }
});

document.getElementById('acAdlistCustomAddBtn')?.addEventListener('click', async () => {
  const urlEl = document.getElementById('acAdlistCustomUrl');
  const labelEl = document.getElementById('acAdlistCustomLabel');
  const status = document.getElementById('acAdlistStatus');
  const btn = document.getElementById('acAdlistCustomAddBtn');
  const url = (urlEl?.value || '').trim();
  const label = (labelEl?.value || '').trim();
  if (!url) { if (status) status.textContent = 'URL required.'; return; }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Subscribing…';
  try {
    const res = await fetch(`${API}/api/network/adlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, comment: label || undefined }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    if (urlEl) urlEl.value = '';
    if (labelEl) labelEl.value = '';
    if (status) status.textContent = 'Added.';
    await loadAccessControl();
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById('acAdlistRefreshBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('acAdlistRefreshBtn');
  const status = document.getElementById('acAdlistStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Asking router to refresh…';
  try {
    const res = await fetch(`${API}/api/network/adlist/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (status) status.textContent = 'Refresh requested.';
    await loadAccessControl();
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

// Common 2-part public suffixes — without this list, foo.com.au would suggest
// "Com" instead of "Foo". Not exhaustive; just the ones AU/UK/EU/Asia users
// hit most. Mirrors a tiny slice of publicsuffix.org.
const TWO_PART_TLDS = new Set([
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'co.nz', 'net.nz', 'org.nz',
  'com.br', 'com.mx', 'com.ar', 'com.co',
  'com.sg', 'com.hk', 'com.tw', 'com.my', 'com.ph',
  'co.jp', 'co.kr', 'co.in', 'co.za', 'co.il',
]);

function acSuggestAppName(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return host;
  const trimmed = parts.filter((p, i) => !(i === 0 && p === 'www'));
  if (trimmed.length < 2) return host;
  const tail2 = trimmed.slice(-2).join('.');
  const rootIdx = TWO_PART_TLDS.has(tail2) ? trimmed.length - 3 : trimmed.length - 2;
  if (rootIdx < 0) return host;
  const root = trimmed[rootIdx];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

function renderAccessControl() {
  const cats = acCategoriesData;
  const uncat = acUncatData;
  const meta = document.getElementById('acCategoriesMeta');
  const uncatList = document.getElementById('acUncatList');
  const catList = document.getElementById('acCategoryList');
  if (!catList || !uncatList) return;

  if (!cats || !uncat) {
    uncatList.innerHTML = '<li class="muted small">Couldn\'t load.</li>';
    catList.innerHTML = '';
    if (meta) meta.textContent = '';
    return;
  }

  const totalEntries = Object.values(cats.categories || {}).reduce((s, c) => s + (c.entries?.length || 0), 0);
  const userEntries = Object.values(cats.categories || {})
    .reduce((s, c) => s + (c.entries || []).filter(e => e.source === 'user').length, 0);
  if (meta) meta.textContent = `${totalEntries} known suffixes · ${userEntries} your overrides`;

  // Uncategorized list — quick-assign affordance
  const items = uncat.items || [];
  if (items.length === 0) {
    uncatList.innerHTML = '<li class="muted small">No uncategorized destinations in the last week.</li>';
  } else {
    uncatList.innerHTML = items.map(it => `
      <li class="ac-uncat-row" data-hostname="${esc(it.hostname)}">
        <span class="ac-uncat-name">${esc(it.hostname)}</span>
        <span class="muted small">${it.count.toLocaleString()}× · last ${esc(timeAgo(it.last_seen) || '')}</span>
        <span class="ac-uncat-actions">
          <input type="text" class="ac-uncat-app" placeholder="App name" value="${esc(acSuggestAppName(it.hostname))}">
          <select class="ac-uncat-cat">${(cats.order || []).map(c => `<option value="${c}"${c === 'social' ? ' selected' : ''}>${c}</option>`).join('')}</select>
          <button type="button" class="btn-sm" data-ac-uncat-action="assign">Add</button>
        </span>
      </li>
    `).join('');
  }

  // Per-category accordion
  const ordered = [...(cats.order || [])].sort((a, b) => {
    const ar = cats.categories[a]?.count_recent_7d ?? 0;
    const br = cats.categories[b]?.count_recent_7d ?? 0;
    if (ar !== br) return br - ar;
    return a.localeCompare(b);
  });
  catList.innerHTML = ordered.map(cat => {
    const c = cats.categories[cat];
    if (!c) return '';
    const color = CATEGORY_COLORS[cat] || '#ccc';
    const entries = (c.entries || []).slice().sort((a, b) => a.suffix.localeCompare(b.suffix));
    return `
      <details class="ac-cat-block" data-cat="${esc(cat)}">
        <summary class="ac-cat-summary">
          <span class="ac-cat-swatch" style="background:${color}"></span>
          <span class="ac-cat-name">${esc(cat)}</span>
          <span class="ac-cat-counts">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · ${c.count_recent_7d.toLocaleString()} queries/wk</span>
        </summary>
        <div class="ac-cat-body">
          <ol class="ac-cat-entries">
            ${entries.map(e => `
              <li class="ac-cat-entry-row" data-suffix="${esc(e.suffix)}">
                <span class="ac-cat-suffix">${esc(e.suffix)}</span>
                <span class="muted small">${esc(e.app)}</span>
                <span class="ac-entry-source ${e.source === 'user' ? 'is-user' : ''}">${e.source}</span>
                <button type="button" class="ac-cat-remove" data-ac-cat-action="remove" data-suffix="${esc(e.suffix)}" title="${e.source === 'user' ? 'Remove this user entry' : 'Built-in — add a user entry with the same suffix to override'}">×</button>
              </li>`).join('')}
          </ol>
          <div class="ac-cat-add">
            <input type="text" class="ac-cat-add-suffix" placeholder="example.com">
            <input type="text" class="ac-cat-add-app"    placeholder="App name (e.g. Reddit)">
            <button type="button" class="btn-sm" data-ac-cat-action="add" data-cat="${esc(cat)}">Add suffix</button>
          </div>
        </div>
      </details>`;
  }).join('');
}

// Click delegation for the Access Control category UI
document.addEventListener('click', async (e) => {
  // Uncategorized → assign
  const assignBtn = e.target.closest('[data-ac-uncat-action="assign"]');
  if (assignBtn) {
    e.preventDefault();
    const row = assignBtn.closest('.ac-uncat-row');
    if (!row) return;
    const hostname = row.dataset.hostname;
    const app = row.querySelector('.ac-uncat-app')?.value.trim();
    const category = row.querySelector('.ac-uncat-cat')?.value;
    if (!app || !category) return;
    try {
      await fetch(`${API}/api/network/categories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', suffix: hostname, app, category }),
      });
      showEeroToast(`Added ${hostname} → ${app} (${category})`);
      loadAccessControl();
    } catch (err) { alert(err.message); }
    return;
  }
  // Category → add suffix
  const addBtn = e.target.closest('[data-ac-cat-action="add"]');
  if (addBtn) {
    e.preventDefault();
    const block = addBtn.closest('.ac-cat-block');
    if (!block) return;
    const suffix = block.querySelector('.ac-cat-add-suffix')?.value.trim();
    const app = block.querySelector('.ac-cat-add-app')?.value.trim();
    const category = addBtn.dataset.cat;
    if (!suffix || !app || !category) { alert('Need both suffix and app name'); return; }
    try {
      await fetch(`${API}/api/network/categories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', suffix, app, category }),
      });
      showEeroToast(`Added ${suffix} → ${app} (${category})`);
      loadAccessControl();
    } catch (err) { alert(err.message); }
    return;
  }
  // Category → remove user entry
  const removeBtn = e.target.closest('[data-ac-cat-action="remove"]');
  if (removeBtn) {
    e.preventDefault();
    const row = removeBtn.closest('.ac-cat-entry-row');
    const source = row?.querySelector('.ac-entry-source')?.textContent;
    if (source !== 'user') {
      alert('Built-in entries can\'t be removed. Add a user entry with the same suffix to override.');
      return;
    }
    try {
      await fetch(`${API}/api/network/categories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', suffix: removeBtn.dataset.suffix }),
      });
      showEeroToast(`Removed ${removeBtn.dataset.suffix}`);
      loadAccessControl();
    } catch (err) { alert(err.message); }
  }
});

// Run policy scan now
document.getElementById('acPolicyScanBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('acPolicyScanBtn');
  const status = document.getElementById('acPolicyScanStatus');
  if (btn) { btn.disabled = true; }
  if (status) status.textContent = 'Running…';
  try {
    const res = await fetch(`${API}/api/network/policy/scan`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    if (status) status.textContent = `Scan complete — ${r.scanned || 0} devices, ${r.flagged || 0} flagged, ${r.blocked || 0} blocked`;
  } catch (err) {
    if (status) status.textContent = `Failed: ${err.message}`;
  } finally {
    if (btn) { btn.disabled = false; }
  }
});

function renderEeroKids() {
  const profile = getKidsProfile();
  const titleEl = document.getElementById('kidsTitle');
  const statusEl = document.getElementById('kidsStatus');
  const gridEl = document.getElementById('kidsGrid');
  const activityEl = document.getElementById('kidsActivity');
  const summaryEl = document.getElementById('kidsActivitySummary');
  const schedListEl = document.getElementById('kidsSchedules');
  const eventsEl = document.getElementById('kidsEvents');
  if (!titleEl || !gridEl) return;

  if (!profile) {
    titleEl.textContent = 'Access Control';
    statusEl.innerHTML = 'Create a profile in the Profiles tab and add devices to it. Access Control will pick up the first non-default profile (or one whose name contains "kid", "school", "bedtime", etc.) and surface its devices, schedules, and filtering here.';
    gridEl.innerHTML = '';
    activityEl.innerHTML = '';
    schedListEl.innerHTML = '';
    eventsEl.innerHTML = '';
    return;
  }

  const allDevices = eeroState.snapshot?.devices || [];
  const profileDeviceUrls = new Set((profile.devices || []).map(d => d.url || d));
  const devices = allDevices.filter(d => profileDeviceUrls.has(d.url));
  const onlineNow = devices.filter(d => d.connected).length;
  const pausedNow = devices.filter(d => d.paused).length;

  // Today's activity from sample history (online presence per device).
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const samples = (eeroHistory || []).filter(e =>
    e.type === 'sample' && Array.isArray(e.data?.onlineMacs) &&
    new Date(e.time).getTime() >= todayStart.getTime()
  );
  const intervalMs = (eeroState.config?.samplerIntervalMs) || 300000;

  // Per-device today's online ticks count
  const devTicks = new Map();
  for (const s of samples) {
    for (const mac of s.data.onlineMacs) {
      if (devices.some(d => d.mac === mac)) {
        devTicks.set(mac, (devTicks.get(mac) || 0) + 1);
      }
    }
  }

  titleEl.textContent = profile.name;
  const statusBits = [
    `${devices.length} device${devices.length !== 1 ? 's' : ''}`,
    `${onlineNow} online`,
    profile.paused ? '<span class="eero-tag paused">profile paused</span>' : '',
    pausedNow ? `${pausedNow} device-paused` : '',
  ].filter(Boolean);
  statusEl.innerHTML = statusBits.join(' · ');

  // Per-device cards
  if (devices.length === 0) {
    gridEl.innerHTML = `<div class="muted small" style="padding:16px">No devices in <strong>${esc(profile.name)}</strong> profile yet. Add them in the Profiles tab.</div>`;
  } else {
    gridEl.innerHTML = devices.map(d => {
      const online = !!d.connected;
      const paused = !!d.paused || !!profile.paused;
      const todayMin = Math.round((devTicks.get(d.mac) || 0) * intervalMs / 60000);
      return `
        <div class="kids-device-card ${online ? 'online' : 'offline'} ${paused ? 'paused' : ''}">
          <div class="kids-device-head">
            <span class="kids-device-dot ${online ? 'online' : 'offline'}"></span>
            <span class="kids-device-name">${esc(d.display_name || d.hostname || d.mac)}</span>
            ${paused ? '<span class="eero-tag paused">paused</span>' : ''}
          </div>
          <div class="kids-device-stat">
            <span class="kids-stat-num">${formatHumanDuration(todayMin)}</span>
            <span class="muted small">online today</span>
          </div>
          <div class="kids-device-meta muted small">${esc(d.ip || '')} · ${esc(d.connection_type || '')}</div>
          <div class="kids-device-actions">
            <button class="btn-sm" data-kids-act="pause-toggle" data-url="${esc(d.url)}" data-name="${esc(d.display_name || d.hostname || d.mac)}" data-on="${paused ? '1' : '0'}">${paused ? 'Resume' : 'Pause'}</button>
            <button class="btn-sm" data-kids-act="pause-15" data-url="${esc(d.url)}" data-name="${esc(d.display_name || d.hostname || d.mac)}">+15m</button>
            <button class="btn-sm" data-kids-act="pause-1h" data-url="${esc(d.url)}" data-name="${esc(d.display_name || d.hostname || d.mac)}">+1h</button>
            <button class="btn-sm" data-kids-act="pause-bedtime" data-url="${esc(d.url)}" data-name="${esc(d.display_name || d.hostname || d.mac)}">Until 7am</button>
          </div>
        </div>
      `;
    }).join('');

    gridEl.querySelectorAll('[data-kids-act]').forEach(b => {
      b.onclick = async () => {
        const url = b.dataset.url;
        const name = b.dataset.name;
        const target = { type: 'device', url, displayName: name };
        switch (b.dataset.kidsAct) {
          case 'pause-toggle':
            await fetch(`${API}/api/eero/devices/pause`, eeroPut({ deviceUrl: url, paused: b.dataset.on !== '1' }));
            await eeroSync();
            renderEeroKids();
            break;
          case 'pause-15': await pauseTargetFor(target, 15); renderEeroKids(); break;
          case 'pause-1h': await pauseTargetFor(target, 60); renderEeroKids(); break;
          case 'pause-bedtime': {
            const minutes = minutesUntilNext(7, 0);
            await pauseTargetFor(target, minutes);
            renderEeroKids();
            break;
          }
        }
      };
    });
  }

  // Today's activity timeline — per device, 24h strip
  const totalMin = Array.from(devTicks.values()).reduce((a, n) => a + n, 0) * intervalMs / 60000;
  summaryEl.textContent = devices.length ? `${formatHumanDuration(Math.round(totalMin))} combined online time today` : '';
  activityEl.innerHTML = devices.length === 0 ? '' : renderKidsTimeline(devices, samples, intervalMs);

  // Schedules targeting any kids device or the kids profile
  const kidsSchedules = (eeroState.schedules || []).filter(s => {
    if (s.target.type === 'profile' && s.target.url === profile.url) return true;
    if (s.target.type === 'device' && profileDeviceUrls.has(s.target.url)) return true;
    return false;
  });
  schedListEl.innerHTML = kidsSchedules.length === 0
    ? '<div class="muted small" style="padding:8px">No kids-specific schedules. Use the presets above to create one.</div>'
    : kidsSchedules.map(s => `
      <div class="kids-sched">
        <div>
          <div>${esc(s.name)} ${s.enabled ? '' : '<span class="eero-tag paused">disabled</span>'}</div>
          <div class="muted small">${esc(s.target.displayName || '')} · ${esc(describeSchedule(s))}</div>
        </div>
        <button class="btn-sm btn-danger" data-act="kids-sched-del" data-id="${esc(s.id)}">Remove</button>
      </div>
    `).join('');
  schedListEl.querySelectorAll('[data-act="kids-sched-del"]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Remove this schedule?')) return;
      await fetch(`${API}/api/eero/schedules/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
      await refreshEeroSchedules();
      renderEeroKids();
    };
  });

  // Recent events filtered to kids' MACs
  const kidsMacs = new Set(devices.map(d => d.mac).filter(Boolean));
  const events = (eeroHistory || [])
    .filter(e => e.type !== 'sample' && (e.data?.mac && kidsMacs.has(e.data.mac)))
    .slice(-30).reverse();
  eventsEl.innerHTML = events.length === 0
    ? '<div class="muted small" style="padding:8px">No recent events.</div>'
    : events.map(e => `
      <div class="eero-event">
        <span class="eero-event-type ${e.type}">${e.type.replace(/-/g, ' ')}</span>
        <span>${esc(e.data.name || e.data.display_name || e.data.mac)}</span>
        <span class="muted small">${timeAgo(e.time)}</span>
      </div>
    `).join('');
}

// Does a recurring rule cover (dow, minutesOfDay)? Mirrors the server-side
// EeroScheduler.isInRule logic so the UI doesn't need to round-trip.
function ruleCoversMinute(rule, dow, minutesNow) {
  const s = rule.startMinutes, e = rule.endMinutes;
  if (s === e) return false;
  if (s < e) return rule.days.includes(dow) && minutesNow >= s && minutesNow < e;
  // Crosses midnight
  if (rule.days.includes(dow) && minutesNow >= s) return true;
  const yesterday = (dow + 6) % 7;
  if (rule.days.includes(yesterday) && minutesNow < e) return true;
  return false;
}

function deviceBlockedRanges(device, profile, schedules, todayStart) {
  // Returns an array of { startMs, endMs } in [0, dayMs] where this device
  // was scheduled-blocked today.
  const dayMs = 24 * 3600 * 1000;
  const stepMin = 5;
  const cells = new Array(Math.ceil(24 * 60 / stepMin)).fill(false);
  const targetsThis = (s) => {
    if (!s.enabled) return false;
    if (s.target.type === 'device' && s.target.url === device.url) return true;
    if (s.target.type === 'profile' && profile && s.target.url === profile.url) return true;
    return false;
  };
  // Recurring rules
  for (const s of schedules) {
    if (!targetsThis(s) || !s.rules) continue;
    const dow = todayStart.getDay();
    for (let i = 0; i < cells.length; i++) {
      const minutesNow = i * stepMin;
      for (const r of s.rules) {
        if (ruleCoversMinute(r, dow, minutesNow)) { cells[i] = true; break; }
      }
    }
  }
  // One-off pauseUntil
  for (const s of schedules) {
    if (!targetsThis(s) || !s.pauseUntil) continue;
    const until = new Date(s.pauseUntil).getTime();
    const created = new Date(s.createdAt).getTime();
    const startMs = Math.max(0, created - todayStart.getTime());
    const endMs = Math.min(dayMs, until - todayStart.getTime());
    if (endMs <= 0 || startMs >= dayMs) continue;
    const i0 = Math.floor(startMs / (stepMin * 60000));
    const i1 = Math.ceil(endMs / (stepMin * 60000));
    for (let i = i0; i < i1 && i < cells.length; i++) cells[i] = true;
  }
  // Coalesce contiguous true runs
  const ranges = [];
  let runStart = -1;
  for (let i = 0; i <= cells.length; i++) {
    if (cells[i] && runStart < 0) runStart = i;
    if ((!cells[i] || i === cells.length) && runStart >= 0) {
      ranges.push({ startMs: runStart * stepMin * 60000, endMs: i * stepMin * 60000 });
      runStart = -1;
    }
  }
  return ranges;
}

function renderKidsTimeline(devices, samples, intervalMs) {
  const w = 720, rowH = 26, labelW = 130;
  const headerH = 24;                       // hour labels area
  const rowsTop = headerH;
  const rowsH = devices.length * rowH;
  const legendGap = 8;
  const legendH = 18;
  const h = headerH + rowsH + legendGap + legendH;
  const trackW = w - labelW - 10;
  const dayMs = 24 * 3600 * 1000;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const ms2x = ms => labelW + (Math.max(0, Math.min(dayMs, ms)) / dayMs) * trackW;

  // Per-device, per-bucket presence
  const presence = new Map();
  for (const d of devices) presence.set(d.mac, new Array(Math.ceil(dayMs / intervalMs)).fill(false));
  for (const s of samples) {
    const t = new Date(s.time).getTime() - todayStart.getTime();
    if (t < 0 || t >= dayMs) continue;
    const idx = Math.floor(t / intervalMs);
    for (const mac of s.data.onlineMacs) {
      const arr = presence.get(mac);
      if (arr && idx < arr.length) arr[idx] = true;
    }
  }

  const allProfiles = eeroState.snapshot?.profiles || [];
  const allSchedules = eeroState.schedules || [];

  const rowsBottom = rowsTop + rowsH;

  // Hour ticks — vertical lines stop at the rows area, don't bleed into legend
  let ticks = '';
  for (let hr = 0; hr <= 24; hr += 3) {
    const x = ms2x(hr * 3600 * 1000);
    ticks += `<line x1="${x}" y1="${headerH - 4}" x2="${x}" y2="${rowsBottom}" class="eero-axis"/>`;
    ticks += `<text x="${x}" y="${headerH - 10}" text-anchor="middle" class="eero-axis-label">${String(hr).padStart(2, '0')}:00</text>`;
  }

  // Now line — only spans the rows area
  const nowMs = Date.now() - todayStart.getTime();
  const nowX = ms2x(nowMs);
  ticks += `<line x1="${nowX}" y1="${headerH - 4}" x2="${nowX}" y2="${rowsBottom}" stroke="#c45a5a" stroke-width="1" stroke-dasharray="3 3"/>`;
  ticks += `<text x="${nowX + 4}" y="${headerH - 10}" class="eero-axis-label" fill="#c45a5a">now</text>`;

  // Per-device rows
  let rows = '';
  devices.forEach((d, i) => {
    const y = rowsTop + i * rowH;
    const profile = allProfiles.find(p => p.url === d.profile?.url);
    const blocks = deviceBlockedRanges(d, profile, allSchedules, todayStart);
    const blockedSet = new Set();
    for (const b of blocks) {
      const i0 = Math.floor(b.startMs / intervalMs);
      const i1 = Math.ceil(b.endMs / intervalMs);
      for (let k = i0; k < i1; k++) blockedSet.add(k);
    }

    rows += `<text x="6" y="${y + rowH / 2 + 4}" class="kids-timeline-name">${esc(d.display_name || d.hostname || d.mac)}</text>`;
    rows += `<rect x="${labelW}" y="${y + 4}" width="${trackW}" height="${rowH - 8}" fill="var(--bg-deep, #f1efe9)" stroke="var(--border, #ddd)" stroke-width="0.5"/>`;

    // Layer 1: green bars where the device was online AND not blocked
    const arr = presence.get(d.mac) || [];
    let runStart = -1;
    for (let j = 0; j <= arr.length; j++) {
      const onlineNotBlocked = arr[j] && !blockedSet.has(j);
      if (onlineNotBlocked && runStart < 0) runStart = j;
      if ((!onlineNotBlocked || j === arr.length) && runStart >= 0) {
        const x1 = ms2x(runStart * intervalMs);
        const x2 = ms2x(j * intervalMs);
        rows += `<rect x="${x1}" y="${y + 4}" width="${Math.max(1, x2 - x1)}" height="${rowH - 8}" fill="#59a263" fill-opacity="0.7"><title>online</title></rect>`;
        runStart = -1;
      }
    }

    // Layer 2: red bars over blocked windows (drawn on top, win visually)
    for (const b of blocks) {
      const x1 = ms2x(b.startMs);
      const x2 = ms2x(b.endMs);
      rows += `<rect x="${x1}" y="${y + 4}" width="${Math.max(1, x2 - x1)}" height="${rowH - 8}" fill="#c45a5a" fill-opacity="0.75"><title>blocked by schedule</title></rect>`;
    }
  });

  // Legend — rendered below the rows in its own dedicated band
  const legendY = rowsBottom + legendGap + 12;
  const legend = `
    <g class="kids-timeline-legend">
      <rect x="${labelW}" y="${legendY - 10}" width="10" height="8" fill="#59a263" fill-opacity="0.7"/>
      <text x="${labelW + 14}" y="${legendY - 3}" class="eero-axis-label">online</text>
      <rect x="${labelW + 70}" y="${legendY - 10}" width="10" height="8" fill="#c45a5a" fill-opacity="0.75"/>
      <text x="${labelW + 84}" y="${legendY - 3}" class="eero-axis-label">blocked</text>
    </g>
  `;

  return `<svg viewBox="0 0 ${w} ${h}" class="kids-timeline">${ticks}${rows}${legend}</svg>`;
}

function minutesUntilNext(hour, minute) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.round((target - now) / 60000);
}

async function applyKidsPreset(preset) {
  const profile = getKidsProfile();
  if (!profile) { alert('Create a Kids profile first.'); return; }
  const target = { type: 'profile', url: profile.url, displayName: profile.name };
  switch (preset) {
    case 'pause-now':
      await fetch(`${API}/api/eero/profiles/pause`, eeroPut({ profileUrl: profile.url, paused: true }));
      break;
    case 'unpause-now':
      // Cancel one-off schedules targeting kids and unpause profile + any device-paused kids devices.
      for (const s of (eeroState.schedules || [])) {
        if (s.pauseUntil && (s.target.url === profile.url || (eeroState.snapshot?.devices || []).some(d => d.url === s.target.url && (d.profile?.url === profile.url)))) {
          await fetch(`${API}/api/eero/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        }
      }
      await fetch(`${API}/api/eero/profiles/pause`, eeroPut({ profileUrl: profile.url, paused: false }));
      // also un-pause individual paused devices in the profile
      const allDevices = eeroState.snapshot?.devices || [];
      const inProfile = allDevices.filter(d => d.profile?.url === profile.url && d.paused);
      for (const d of inProfile) {
        await fetch(`${API}/api/eero/devices/pause`, eeroPut({ deviceUrl: d.url, paused: false }));
      }
      break;
    case 'until-7am':
      await fetch(`${API}/api/eero/schedules/pause-for`, eeroPost({ target, minutes: minutesUntilNext(7, 0) }));
      break;
    case 'for-1h':
      await fetch(`${API}/api/eero/schedules/pause-for`, eeroPost({ target, minutes: 60 }));
      break;
    case 'for-15m':
      await fetch(`${API}/api/eero/schedules/pause-for`, eeroPost({ target, minutes: 15 }));
      break;
    case 'bedtime-schedule':
      await fetch(`${API}/api/eero/schedules`, eeroPost({
        name: `${profile.name} bedtime`,
        target,
        rules: [{ days: [0,1,2,3,4,5,6], startMinutes: 21*60, endMinutes: 7*60 }],
        enabled: true,
      }));
      break;
    case 'school-schedule':
      await fetch(`${API}/api/eero/schedules`, eeroPost({
        name: `${profile.name} school hours`,
        target,
        rules: [{ days: [1,2,3,4,5], startMinutes: 9*60, endMinutes: 15*60 }],
        enabled: true,
      }));
      break;
  }
  await eeroSync();
  await refreshEeroSchedules();
  renderEeroKids();
  showEeroToast(`Done: ${preset.replace(/-/g, ' ')}`);
}

// ── schedule (block / unblock) ─────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// MikroTik-driven Schedule subtab (step 10). Schedules are stored on the
// router as firewall rules with a `time` matcher; gombwe just orchestrates
// the CRUD. Function names kept (renderEeroSchedule, refreshEeroSchedules,
// etc.) to avoid churning existing call sites.
let mtSchedules = [];

async function refreshEeroSchedules() {
  try {
    const r = await fetch(`${API}/api/network/schedules`);
    mtSchedules = await r.json();
  } catch { mtSchedules = []; }
  renderEeroSchedule();
}

const MT_DAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function deviceLabel(mac) {
  const d = (networkState?.devices || []).find(x => x.mac === mac);
  return d ? (d.name || d.hostname || mac) : mac;
}

function describeSchedule(s) {
  if (s.type === 'pause-until' && s.pause_until) {
    const until = new Date(s.pause_until);
    const mins = Math.max(0, Math.round((until - new Date()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    const remaining = mins <= 0 ? 'lifting now' : h ? `${h}h ${m}m left` : `${m}m left`;
    return `paused until ${until.toLocaleString()} (${remaining})`;
  }
  if (!s.days?.length) return `every day ${s.start_time}–${s.end_time}`;
  const ordered = s.days.slice().sort((a, b) => MT_DAY_ORDER.indexOf(a) - MT_DAY_ORDER.indexOf(b));
  const weekdayBlock = ['mon','tue','wed','thu','fri'];
  const isWeekdays = ordered.length === 5 && ordered.every((d, i) => d === weekdayBlock[i]);
  const isAllDays = ordered.length === 7;
  const isWeekend = ordered.length === 2 && ordered[0] === 'sat' && ordered[1] === 'sun';
  let dayPart;
  if (isAllDays)        dayPart = 'every day';
  else if (isWeekdays)  dayPart = 'Mon–Fri';
  else if (isWeekend)   dayPart = 'Sat/Sun';
  else                  dayPart = ordered.map(d => d[0].toUpperCase() + d.slice(1)).join(', ');
  return `${dayPart} ${s.start_time}–${s.end_time}`;
}

function renderEeroSchedule() {
  const grid = document.getElementById('eeroScheduleGrid');
  const list = document.getElementById('eeroScheduleList');
  const summary = document.getElementById('eeroSchedSummary');
  if (!grid || !list) return;
  const schedules = mtSchedules || [];
  const active = schedules.filter(s => s.enabled);
  if (summary) summary.textContent = `${schedules.length} schedule${schedules.length !== 1 ? 's' : ''} (${active.length} enabled)`;

  // Group by MAC for the weekly grid.
  const byMac = new Map();
  for (const s of schedules) {
    if (!byMac.has(s.mac)) byMac.set(s.mac, { mac: s.mac, name: deviceLabel(s.mac), schedules: [] });
    byMac.get(s.mac).schedules.push(s);
  }
  if (byMac.size === 0) {
    grid.innerHTML = '<div class="muted small" style="padding:16px">No schedules yet. Click <strong>+ New schedule</strong> above.</div>';
  } else {
    grid.innerHTML = Array.from(byMac.values()).map(g => renderTargetCalendar(g)).join('');
  }

  // Flat schedule list with edit/delete/toggle.
  if (schedules.length === 0) {
    list.innerHTML = '<div class="muted small" style="padding:16px">No schedules.</div>';
  } else {
    list.innerHTML = schedules.map(s => `
      <div class="eero-sched-row">
        <div>
          <div class="eero-sched-name">${esc(s.name)} ${s.enabled ? '' : '<span class="eero-tag paused">disabled</span>'}</div>
          <div class="muted small">${esc(deviceLabel(s.mac))} · ${esc(describeSchedule(s))}</div>
        </div>
        <div class="eero-sched-actions">
          <label class="eero-toggle small"><input type="checkbox" data-act="sched-toggle" data-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''}><span></span></label>
          <button class="btn-sm" data-act="sched-edit" data-id="${esc(s.id)}">Edit</button>
          <button class="btn-sm btn-danger" data-act="sched-delete" data-id="${esc(s.id)}">Delete</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('[data-act="sched-toggle"]').forEach(el => {
      el.onchange = async () => {
        await fetch(`${API}/api/network/schedules/${encodeURIComponent(el.dataset.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: el.checked }),
        });
        refreshEeroSchedules();
      };
    });
    list.querySelectorAll('[data-act="sched-edit"]').forEach(el => {
      el.onclick = () => openSchedModal(el.dataset.id);
    });
    list.querySelectorAll('[data-act="sched-delete"]').forEach(el => {
      el.onclick = async () => {
        if (!confirm('Delete this schedule? The firewall rule will be removed immediately.')) return;
        await fetch(`${API}/api/network/schedules/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
        refreshEeroSchedules();
      };
    });
  }
}

function minutesToTime(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Per-device weekly calendar — 7 days × 24 hours, blocks shaded.
// Adapts to the MikroTik schedule shape: { mac, name, days[], start_time, end_time }.
function renderTargetCalendar({ mac, name, schedules }) {
  const w = 700, dayW = (w - 60) / 7, h = 200, hourH = (h - 24) / 24;
  let blocks = '';
  let labels = '';

  for (let hr = 0; hr <= 24; hr += 6) {
    labels += `<text x="0" y="${24 + hr * hourH + 3}" class="eero-axis-label">${String(hr).padStart(2, '0')}:00</text>`;
  }
  for (let d = 0; d < 7; d++) {
    labels += `<text x="${56 + d * dayW + dayW / 2}" y="14" text-anchor="middle" class="eero-axis-label">${DOW[d]}</text>`;
  }
  for (let d = 0; d <= 7; d++) {
    blocks += `<line x1="${56 + d * dayW}" y1="20" x2="${56 + d * dayW}" y2="${h - 4}" class="eero-axis"/>`;
  }
  for (let hr = 0; hr <= 24; hr += 6) {
    blocks += `<line x1="56" y1="${24 + hr * hourH}" x2="${w - 4}" y2="${24 + hr * hourH}" class="eero-axis"/>`;
  }

  // For each enabled schedule, draw a block on each active day.
  // Wrap past midnight by drawing a second block on the next day.
  const DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  for (const s of schedules) {
    if (!s.enabled) continue;
    if (s.type === 'pause-until' && s.pause_until) {
      // Pause-until is "blocked from now until pause_until" — draw as a
      // contiguous red bar across however many days that spans.
      const startNow = new Date();
      const end = new Date(s.pause_until);
      const startDow = startNow.getDay();
      const startMin = startNow.getHours() * 60 + startNow.getMinutes();
      const durationMin = Math.max(0, Math.round((end - startNow) / 60000));
      blocks += renderBlockBars(startDow, startMin, Math.min(durationMin, 7 * 24 * 60), dayW, hourH, '#c45a5a', s.name);
      continue;
    }
    const startMin = timeToMinutes(s.start_time);
    const endMin = timeToMinutes(s.end_time);
    for (const day of (s.days || [])) {
      const dow = DAY_IDX[day];
      if (dow === undefined) continue;
      if (endMin > startMin) {
        blocks += renderBlock(dow, startMin, endMin, dayW, hourH, '#5e9bdc', s.name);
      } else {
        blocks += renderBlock(dow, startMin, 1440, dayW, hourH, '#5e9bdc', s.name);
        blocks += renderBlock((dow + 1) % 7, 0, endMin, dayW, hourH, '#5e9bdc', s.name);
      }
    }
  }

  return `
    <div class="eero-sched-target">
      <div class="eero-sched-target-name">${esc(name || mac)} <span class="muted small">(${esc(mac)})</span></div>
      <svg viewBox="0 0 ${w} ${h}" class="eero-sched-svg">
        ${labels}
        ${blocks}
      </svg>
    </div>
  `;
}

function renderBlock(dow, startMin, endMin, dayW, hourH, color, label) {
  const x = 56 + dow * dayW + 1;
  const y = 24 + (startMin / 60) * hourH;
  const height = ((endMin - startMin) / 60) * hourH;
  return `<rect x="${x}" y="${y}" width="${dayW - 2}" height="${height}" fill="${color}" fill-opacity="0.55" stroke="${color}" stroke-opacity="0.9"><title>${esc(label)} — ${minutesToTime(startMin)} to ${minutesToTime(endMin)}</title></rect>`;
}

function renderBlockBars(startDow, startMin, durationMin, dayW, hourH, color, label) {
  // Walks day-by-day from startDow until durationMin runs out.
  let out = '';
  let dow = startDow;
  let cursor = startMin;
  let remaining = durationMin;
  while (remaining > 0 && dow < 7 + startDow) {
    const dayEnd = 1440;
    const inThisDay = Math.min(remaining, dayEnd - cursor);
    out += renderBlock(dow % 7, cursor, cursor + inThisDay, dayW, hourH, color, label);
    remaining -= inThisDay;
    cursor = 0;
    dow++;
  }
  return out;
}

// Reused for both create and edit. id=null = create. MikroTik-driven; one-off
// (pause-until) is deferred — kept hidden so the existing HTML still works.
const DAY_IDX_TO_NAME = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAME_TO_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function openSchedModal(id) {
  eeroSchedEditingId = id;
  const modal = document.getElementById('eeroSchedModal');
  const title = document.getElementById('eeroSchedModalTitle');
  const nameInput = document.getElementById('eeroSchedName');
  const targetSelect = document.getElementById('eeroSchedTarget');
  const typeSelect = document.getElementById('eeroSchedType');
  const recurring = document.getElementById('eeroSchedRecurringFields');
  const oneOff = document.getElementById('eeroSchedOneOffFields');
  const startInput = document.getElementById('eeroSchedStart');
  const endInput = document.getElementById('eeroSchedEnd');
  const deleteBtn = document.getElementById('eeroSchedDeleteBtn');

  // Target list = devices on this LAN. We render every device by friendly
  // name; the value is the MAC since that's what the API needs.
  const devices = networkState?.devices || [];
  targetSelect.innerHTML = devices.map(d => {
    const label = d.name || d.hostname || d.mac;
    const owner = d.owner ? ` · ${d.owner}` : '';
    return `<option value="${esc(d.mac)}">${esc(label)}${esc(owner)} (${esc(d.mac)})</option>`;
  }).join('');

  // Reset to weekday-bedtime defaults
  document.querySelectorAll('#eeroSchedDays input').forEach(c => { c.checked = ['1','2','3','4','5'].includes(c.value); });
  startInput.value = '21:00';
  endInput.value = '07:00';
  typeSelect.value = 'recurring';
  typeSelect.disabled = false;
  recurring.classList.remove('hidden');
  oneOff.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  // Wire the type-switcher (in case it isn't yet) — toggles which fieldset shows.
  if (!typeSelect.dataset.gombweWired) {
    typeSelect.addEventListener('change', () => {
      const oneOffMode = typeSelect.value === 'one-off';
      recurring.classList.toggle('hidden', oneOffMode);
      oneOff.classList.toggle('hidden', !oneOffMode);
    });
    typeSelect.dataset.gombweWired = '1';
  }
  // Default pause-until to 2 hours from now (most common use case: a quick grounding)
  const untilInput2 = document.getElementById('eeroSchedUntil');
  if (untilInput2) {
    const t = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    untilInput2.value = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }

  if (id) {
    const s = (mtSchedules || []).find(x => x.id === id);
    if (s) {
      title.textContent = 'Edit schedule';
      nameInput.value = s.name;
      targetSelect.value = s.mac;
      if (s.type === 'pause-until') {
        typeSelect.value = 'one-off';
        recurring.classList.add('hidden');
        oneOff.classList.remove('hidden');
        if (s.pause_until) {
          const d = new Date(s.pause_until);
          const pad = n => String(n).padStart(2, '0');
          document.getElementById('eeroSchedUntil').value =
            `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      } else {
        document.querySelectorAll('#eeroSchedDays input').forEach(c => {
          const dayName = DAY_IDX_TO_NAME[Number(c.value)];
          c.checked = (s.days || []).includes(dayName);
        });
        startInput.value = s.start_time || '21:00';
        endInput.value = s.end_time || '07:00';
      }
      deleteBtn.classList.remove('hidden');
    }
  } else {
    title.textContent = 'New schedule';
    nameInput.value = '';
  }
  modal.classList.remove('hidden');
}

function closeSchedModal() {
  document.getElementById('eeroSchedModal').classList.add('hidden');
  eeroSchedEditingId = null;
}

async function saveSchedFromModal() {
  const name = document.getElementById('eeroSchedName').value.trim();
  const mac = document.getElementById('eeroSchedTarget').value;
  if (!name || !mac) { alert('Name and device are required'); return; }
  const schedKind = document.getElementById('eeroSchedType').value;

  let body;
  if (schedKind === 'one-off') {
    const until = document.getElementById('eeroSchedUntil').value;
    if (!until) { alert('Pick a pause-until time'); return; }
    // datetime-local has no timezone — interpret as local time, send ISO.
    body = { type: 'pause-until', name, mac, pause_until: new Date(until).toISOString(), enabled: true };
  } else {
    const days = Array.from(document.querySelectorAll('#eeroSchedDays input:checked'))
      .map(c => DAY_IDX_TO_NAME[Number(c.value)]);
    if (days.length === 0) { alert('Pick at least one day'); return; }
    const start_time = document.getElementById('eeroSchedStart').value;
    const end_time = document.getElementById('eeroSchedEnd').value;
    if (!start_time || !end_time) { alert('Start and end times are required'); return; }
    body = { type: 'recurring', name, mac, days, start_time, end_time, enabled: true };
  }

  try {
    let res;
    if (eeroSchedEditingId) {
      res = await fetch(`${API}/api/network/schedules/${encodeURIComponent(eeroSchedEditingId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } else {
      res = await fetch(`${API}/api/network/schedules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    closeSchedModal();
    refreshEeroSchedules();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function pauseTargetFor(target, minutes) {
  await fetch(`${API}/api/eero/schedules/pause-for`, eeroPost({ target, minutes }));
  refreshEeroSchedules();
  showEeroToast(`Paused ${target.displayName} for ${minutes} min`);
}

// ── helpers ────────────────────────────────────────────────────────────
function eeroPost(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

// Build the "paused" tag with the reason as a tooltip and a short suffix.
function renderPauseTag(device) {
  const directlyPaused = !!device.paused;
  const profilePaused = !!device.profile?.paused;
  if (!directlyPaused && !profilePaused) return '';
  const reason = device.pausedReason;
  if (!reason) return '<span class="eero-tag paused">paused</span>';
  if (reason.source === 'schedule') {
    const sub = reason.scope === 'profile' ? ` via ${reason.profile}` : '';
    return `<span class="eero-tag paused" title="Schedule: ${esc(reason.name)}${esc(sub)}">paused — ${esc(reason.name)}</span>`;
  }
  if (reason.source === 'manual' && reason.scope === 'profile') {
    return `<span class="eero-tag paused" title="Profile ${esc(reason.profile)} is manually paused">paused — profile ${esc(reason.profile)}</span>`;
  }
  return '<span class="eero-tag paused" title="Manually paused">paused</span>';
}

// Heuristic: does this device look like an adult's primary device?
const ADULT_NAME_RE = /\b(iphone|macbook|macmini|mac mini|imac|laptop|desktop|surface|thinkpad|ipad pro)\b/i;
function looksLikeAdultDevice(device) {
  const isHost = (eeroState.hostMacs || []).includes((device.mac || '').toLowerCase());
  if (isHost) return true;
  return ADULT_NAME_RE.test(device.display_name || device.hostname || '');
}

function looksLikeKidProfile(profile) {
  return /\b(kid|child|bedtime|school|youth|junior|teen|nursery)\b/i.test(profile?.name || '');
}

// Returns true to proceed, false to cancel. Asks the user when they're about
// to add adult-looking devices to a kid-pattern profile.
function confirmKidProfileAssignment(profile, devicesBeingAdded) {
  if (!looksLikeKidProfile(profile)) return true;
  const adults = (devicesBeingAdded || []).filter(looksLikeAdultDevice);
  if (adults.length === 0) return true;
  const names = adults.map(d => d.display_name || d.hostname || d.mac).join(', ');
  return confirm(
    `These look like adult devices:\n\n  ${names}\n\n` +
    `Adding them to "${profile.name}" means they'll be paused by any schedule attached to that profile (e.g. bedtime).\n\n` +
    `Add anyway?`
  );
}
function eeroPut(body) { return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

async function eeroAction(confirmText, fn) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    const r = await fn();
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(data.error || `HTTP ${r.status}`);
      return;
    }
    eeroSync();
  } catch (err) { alert(err.message); }
}

async function eeroSync() {
  try {
    const r = await fetch(`${API}/api/eero/sync`, eeroPost({}));
    eeroState.snapshot = await r.json();
    setEeroSyncState();
    renderEeroOverview();
    // Devices subtab is MikroTik-driven — fetch its canonical list alongside
    // each eero sync so AP-layer decoration (when present) stays fresh.
    await loadNetworkDevices();
    renderEeroDevices();
    renderEeroProfiles();
    renderEeroSpeed();
    renderEeroAdvanced();
    // Alerts get recomputed server-side after sync; refresh them.
    try {
      const a = await fetch(`${API}/api/eero/alerts`);
      eeroState.alerts = await a.json();
    } catch { /* ignore */ }
    // Refresh MikroTik alerts after every eero sync too — keeps the
    // merged banner consistent.
    await loadNetworkAlerts();
    renderEeroAlerts();
    updateEeroNavBadge();
  } catch (err) { console.error('eero sync failed:', err); }
}

// MikroTik-driven alerts (flapping etc.) live alongside the eero-driven
// ones during the migration. The eero list keeps system-of-eero alerts
// (sampler stale, persistent errors, NextDNS noise); MikroTik gives us
// the device-flapping detection that actually matters in bridged mode.
let networkAlerts = [];

async function loadNetworkAlerts() {
  try {
    const res = await fetch(`${API}/api/network/alerts`);
    if (!res.ok) { networkAlerts = []; return; }
    networkAlerts = await res.json();
  } catch { networkAlerts = []; }
}

function renderEeroAlerts() {
  const container = document.getElementById('eeroAlerts');
  if (!container) return;
  const eeroAll = eeroState.alerts || [];
  // Merge eero alerts + MikroTik alerts. Dedup by id so the same alert
  // can't show twice during the migration overlap. Filter out dismissed
  // (only eero alerts have a dismiss flag; MikroTik alerts auto-clear).
  const merged = [...eeroAll.filter(a => !a.dismissed), ...networkAlerts];
  const seen = new Set();
  const active = merged.filter(a => seen.has(a.id) ? false : (seen.add(a.id), true));
  if (active.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = active.map(a => `
    <div class="eero-alert ${esc(a.severity)}" data-id="${esc(a.id)}">
      <div class="eero-alert-icon">${a.severity === 'error' ? '!' : a.severity === 'warning' ? '!' : 'i'}</div>
      <div class="eero-alert-body">
        <div class="eero-alert-title">${esc(a.title)}</div>
        <div class="eero-alert-detail">${esc(a.detail)}</div>
        ${a.suggestion ? `<div class="eero-alert-suggestion">${esc(a.suggestion)}</div>` : ''}
        <div class="eero-alert-meta muted small">first seen ${timeAgo(a.firstSeen)} ago${a.lastSeen !== a.firstSeen ? ` · last seen ${timeAgo(a.lastSeen)} ago` : ''}</div>
      </div>
      <button class="eero-alert-dismiss" data-id="${esc(a.id)}" title="Dismiss">×</button>
    </div>
  `).join('');
  container.querySelectorAll('.eero-alert-dismiss').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id;
      // MikroTik-driven alerts don't have a server-side dismiss; just hide
      // client-side and let them reappear next load if the condition persists.
      const isNetworkAlert = networkAlerts.some(a => a.id === id);
      if (isNetworkAlert) {
        networkAlerts = networkAlerts.filter(a => a.id !== id);
      } else {
        await fetch(`${API}/api/eero/alerts/${encodeURIComponent(id)}/dismiss`, eeroPost({ dismissed: true }));
        eeroState.alerts = (eeroState.alerts || []).map(a => a.id === id ? { ...a, dismissed: true } : a);
      }
      renderEeroAlerts();
      updateEeroNavBadge();
    };
  });
}

function updateEeroNavBadge() {
  const badge = document.getElementById('eeroNavBadge');
  if (!badge) return;
  const eeroActive = (eeroState.alerts || []).filter(a => !a.dismissed);
  const seen = new Set();
  const active = [...eeroActive, ...networkAlerts].filter(a => seen.has(a.id) ? false : (seen.add(a.id), true));
  if (active.length === 0) {
    badge.classList.add('hidden');
    badge.textContent = '';
    return;
  }
  badge.classList.remove('hidden');
  badge.textContent = String(active.length);
  const worst = active.reduce((acc, a) => a.severity === 'error' ? 'error' : (acc === 'error' ? 'error' : a.severity), 'info');
  badge.className = `nav-badge ${worst}`;
}

function handleEeroAlertEvent(event) {
  const a = event.data;
  eeroState.alerts = eeroState.alerts || [];
  const i = eeroState.alerts.findIndex(x => x.id === a.id);
  if (i >= 0) eeroState.alerts[i] = a; else eeroState.alerts.push(a);
  renderEeroAlerts();
  updateEeroNavBadge();
  if (!a.dismissed) showEeroToast(`${a.title} — ${a.detail.slice(0, 80)}`);
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}

function formatHumanDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

function handleEeroEvent(event) {
  if (event.type === 'eero:sample') {
    eeroHistory.push({ type: 'sample', time: event.timestamp, data: event.data });
    if (eeroHistory.length > 1000) eeroHistory.shift();
  } else {
    eeroHistory.push({ type: event.type.replace('eero:', ''), time: event.timestamp, data: event.data });
  }
  // If the eero tab is active, refresh.
  if (document.getElementById('tab-eero')?.classList.contains('active')) {
    renderEeroOverview();
  }
  if (event.type === 'eero:new-device') {
    showEeroToast(`New device on the network: ${event.data.display_name || event.data.mac}`);
  }
}

function showEeroToast(msg) {
  let t = document.getElementById('eeroToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'eeroToast';
    t.className = 'eero-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── tiny SVG charts ────────────────────────────────────────────────────
function eeroLineChart(series, opts = {}) {
  if (!series.length) return '<div class="muted small">No data.</div>';
  const w = 600, h = 140, pad = 24;
  const xs = series.map(p => p.t);
  const ys = series.map(p => p.v);
  const sec = opts.secondary || [];
  const allYs = ys.concat(sec.map(p => p.v));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = 0, ymax = Math.max(1, ...allYs);
  const xScale = t => pad + (xmax === xmin ? 0 : ((t - xmin) / (xmax - xmin)) * (w - pad * 2));
  const yScale = v => h - pad - ((v - ymin) / (ymax - ymin)) * (h - pad * 2);
  const line = (pts, cls) => `<polyline class="${cls}" fill="none" points="${pts.map(p => `${xScale(p.t)},${yScale(p.v)}`).join(' ')}"/>`;
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="eero-svg">
      <line x1="${pad}" x2="${w - pad}" y1="${h - pad}" y2="${h - pad}" class="eero-axis"/>
      <line x1="${pad}" x2="${pad}" y1="${pad}" y2="${h - pad}" class="eero-axis"/>
      ${line(series, 'eero-line primary')}
      ${sec.length ? line(sec, 'eero-line secondary') : ''}
      <text x="${pad}" y="${pad - 6}" class="eero-axis-label">${esc(opts.yLabel || '')}</text>
      <text x="${w - pad}" y="${h - 4}" text-anchor="end" class="eero-axis-label">max ${ymax.toFixed(0)}</text>
    </svg>
  `;
}

function eeroDualSeriesChart(series) {
  // series[i] = { type: 'DOWNLOAD'|'UPLOAD', values: [{ time, value }] }
  if (!series.length) return '<div class="muted small">No data.</div>';
  const w = 720, h = 180, pad = 30;
  const allValues = series.flatMap(s => s.values || []);
  if (!allValues.length) return '<div class="muted small">No data.</div>';
  const xs = allValues.map(v => new Date(v.time).getTime());
  const ymax = Math.max(1, ...allValues.map(v => v.value));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const xScale = t => pad + (xmax === xmin ? 0 : ((t - xmin) / (xmax - xmin)) * (w - pad * 2));
  const yScale = v => h - pad - (v / ymax) * (h - pad * 2);
  const seriesEls = series.map(s => {
    const pts = (s.values || []).map(v => `${xScale(new Date(v.time).getTime())},${yScale(v.value)}`).join(' ');
    const cls = String(s.type).toLowerCase().includes('down') ? 'primary' : 'secondary';
    return `<polyline class="eero-line ${cls}" fill="none" points="${pts}"/>`;
  }).join('');
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="eero-svg">
      <line x1="${pad}" x2="${w - pad}" y1="${h - pad}" y2="${h - pad}" class="eero-axis"/>
      ${seriesEls}
      <text x="${pad}" y="${pad - 8}" class="eero-axis-label">peak ${formatBytes(ymax)}</text>
      <g class="eero-legend">
        <rect x="${w - 140}" y="6" width="10" height="10" class="eero-line primary swatch"/>
        <text x="${w - 124}" y="15" class="eero-axis-label">download</text>
        <rect x="${w - 70}" y="6" width="10" height="10" class="eero-line secondary swatch"/>
        <text x="${w - 54}" y="15" class="eero-axis-label">upload</text>
      </g>
    </svg>
  `;
}

function eeroHourlyHeatmap(samples) {
  // Bucket by day-of-week × hour, average online count.
  const buckets = Array.from({ length: 7 }, () => Array(24).fill({ sum: 0, n: 0 }));
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) buckets[d][h] = { sum: 0, n: 0 };
  for (const s of samples) {
    const t = new Date(s.time);
    const d = (t.getDay() + 6) % 7; // Mon=0
    buckets[d][t.getHours()].sum += s.data.onlineCount || 0;
    buckets[d][t.getHours()].n += 1;
  }
  const cellW = 18, cellH = 16, pad = 30, w = pad + 24 * cellW + 10, h = pad + 7 * cellH + 10;
  let max = 0;
  for (let d = 0; d < 7; d++) for (let hr = 0; hr < 24; hr++) {
    const b = buckets[d][hr];
    if (b.n) max = Math.max(max, b.sum / b.n);
  }
  let cells = '';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let d = 0; d < 7; d++) {
    cells += `<text x="4" y="${pad + d * cellH + cellH - 4}" class="eero-axis-label">${days[d]}</text>`;
    for (let hr = 0; hr < 24; hr++) {
      const b = buckets[d][hr];
      const v = b.n ? b.sum / b.n : 0;
      const op = max ? (v / max) : 0;
      cells += `<rect x="${pad + hr * cellW}" y="${pad + d * cellH}" width="${cellW - 1}" height="${cellH - 1}" fill="rgba(89,162,99,${op})"><title>${days[d]} ${hr}:00 — avg ${v.toFixed(1)} online</title></rect>`;
    }
  }
  for (let hr = 0; hr < 24; hr += 3) {
    cells += `<text x="${pad + hr * cellW}" y="${pad - 8}" class="eero-axis-label">${hr}</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" class="eero-svg">${cells}</svg>`;
}

// ── wiring ─────────────────────────────────────────────────────────────
document.querySelectorAll('.eero-subtab').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.eero-subtab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    eeroActiveSubtab = b.dataset.eeroTab;
    document.querySelectorAll('.eero-pane').forEach(p => p.classList.toggle('active', p.dataset.eeroPane === eeroActiveSubtab));
    if (eeroActiveSubtab === 'strands') startActivity(); else stopActivity();
    if (eeroActiveSubtab === 'usage') { renderEeroUsageChart(); renderUsageDossier(); }
    if (eeroActiveSubtab === 'audit') renderEeroAudit();   // refresh from /api/network/policy/actions
    if (eeroActiveSubtab === 'profiles') {
      // Profile list = unique owners + family.members. Refresh both so
      // newly-renamed/assigned devices and new members appear immediately.
      Promise.all([
        loadNetworkDevices(),
        fetch(`${API}/api/family`).then(r => r.json()).then(f => { familyData = f; }).catch(() => {}),
      ]).then(renderEeroProfiles);
    }
    if (eeroActiveSubtab === 'kids') { renderEeroKids(); loadAccessControl(); }
    if (eeroActiveSubtab === 'speed') startSpeedPolling(); else stopSpeedPolling();
    if (eeroActiveSubtab === 'overview') renderEeroOverview();
    if (eeroActiveSubtab === 'advanced') renderEeroAdvanced();
    if (eeroActiveSubtab === 'schedule') {
      // Make sure we have a fresh device list for the modal target dropdown.
      Promise.all([loadNetworkDevices?.(), refreshEeroSchedules()]).then(renderEeroSchedule);
    }
  });
});

document.getElementById('eeroLoginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  eeroLastLoginId = document.getElementById('eeroLoginInput').value.trim();
  if (!eeroLastLoginId) return;
  const r = await fetch(`${API}/api/eero/login`, eeroPost({ login: eeroLastLoginId }));
  if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'login failed'); return; }
  document.getElementById('eeroLoginStep').classList.add('hidden');
  document.getElementById('eeroVerifyStep').classList.remove('hidden');
});

document.getElementById('eeroVerifyForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('eeroVerifyInput').value.trim();
  const r = await fetch(`${API}/api/eero/verify`, eeroPost({ code }));
  if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'verify failed'); return; }
  loadEero();
});

document.getElementById('eeroSyncBtn')?.addEventListener('click', () => eeroSync());
document.getElementById('eeroRefreshBtn')?.addEventListener('click', () => loadEero());

document.getElementById('eeroDeviceSearch')?.addEventListener('input', (e) => { eeroDeviceQuery = e.target.value; renderEeroDevices(); });
document.getElementById('eeroDeviceSort')?.addEventListener('change', (e) => { eeroDeviceSort = e.target.value; renderEeroDevices(); });
document.getElementById('eeroDeviceFilter')?.addEventListener('change', (e) => { eeroDeviceFilter = e.target.value; renderEeroDevices(); });

document.querySelectorAll('[data-bulk]').forEach(b => {
  b.addEventListener('click', async () => {
    const op = b.dataset.bulk;
    if (op === 'clear') { eeroSelectedDevices.clear(); renderEeroDevices(); return; }
    const macs = Array.from(eeroSelectedDevices);   // selection set holds MACs now
    if (macs.length === 0) return;
    // Bulk pause/block/unblock all hit /api/network/devices/:mac/(un)block
    // — no MikroTik bulk endpoint, so we fan out.
    if (op === 'pause' || op === 'block') {
      await Promise.all(macs.map(m =>
        fetch(`${API}/api/network/devices/${encodeURIComponent(m)}/block`, { method: 'POST' })));
    } else if (op === 'unpause' || op === 'unblock') {
      await Promise.all(macs.map(m =>
        fetch(`${API}/api/network/devices/${encodeURIComponent(m)}/unblock`, { method: 'POST' })));
    }
    eeroSelectedDevices.clear();
    refreshDevicesPanel();
  });
});

// New profile = add a person to family.members. The profile shows up
// immediately (0 devices) and you assign devices to it from the Devices
// subtab's owner dropdown or from this subtab's "Manage devices" expand.
document.getElementById('eeroNewProfileForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('eeroNewProfileName');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    // Load latest family, append member, save back. /api/family is PUT-all
    // because the family object is small.
    const res = await fetch(`${API}/api/family`);
    const family = await res.json();
    if (!Array.isArray(family.members)) family.members = [];
    if (family.members.some(m => (m.name || '').toLowerCase() === name.toLowerCase())) {
      alert(`A profile named "${name}" already exists.`);
      return;
    }
    family.members.push({ name, type: 'adult' });
    const save = await fetch(`${API}/api/family`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(family),
    });
    if (!save.ok) {
      const d = await save.json().catch(() => ({}));
      alert(d.error || `Failed: HTTP ${save.status}`);
      return;
    }
    familyData = family;   // keep in-memory state in sync
    input.value = '';
    showEeroToast(`Created profile: ${name}`);
    renderEeroProfiles();
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
  }
});

document.getElementById('eeroUsageRange')?.addEventListener('change', () => { renderEeroUsageChart(); renderUsageDossier(); });
document.getElementById('eeroUsageTarget')?.addEventListener('change', renderEeroUsageChart);

// ── Raw MikroTik REST console (step 9) ────────────────────────
document.getElementById('rawMtSendBtn')?.addEventListener('click', sendRawMt);
document.getElementById('rawMtPath')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendRawMt();
});

async function sendRawMt() {
  const method = document.getElementById('rawMtMethod').value;
  const path = document.getElementById('rawMtPath').value.trim();
  const bodyText = document.getElementById('rawMtBody').value.trim();
  const out = document.getElementById('rawMtOutput');
  const meta = document.getElementById('rawMtMeta');
  if (!path) { out.textContent = '// path is required'; return; }
  let body;
  if (bodyText) {
    try { body = JSON.parse(bodyText); }
    catch { out.textContent = '// Body is not valid JSON'; return; }
  }
  out.textContent = '...';
  if (meta) meta.textContent = '';
  const started = Date.now();
  try {
    const res = await fetch(`${API}/api/network/mt-raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, body }),
    });
    const data = await res.json();
    const elapsed = Date.now() - started;
    if (!res.ok || data.ok === false) {
      out.textContent = JSON.stringify(data, null, 2);
      if (meta) meta.textContent = `error · ${elapsed}ms`;
      return;
    }
    out.textContent = JSON.stringify(data.result, null, 2);
    const itemCount = Array.isArray(data.result) ? `${data.result.length} items` : 'object';
    if (meta) meta.textContent = `${method} ${path} · ${data.ms ?? elapsed}ms · ${itemCount}`;
  } catch (err) {
    out.textContent = String(err.message);
    if (meta) meta.textContent = 'request failed';
  }
}

document.querySelectorAll('[data-raw-mt-quick]').forEach(b => {
  b.addEventListener('click', () => {
    const v = b.dataset.rawMtQuick;
    const [m, ...rest] = v.split(' ');
    const p = rest.join(' ');
    const ms = document.getElementById('rawMtMethod');
    const ps = document.getElementById('rawMtPath');
    if (ms) ms.value = m;
    if (ps) { ps.value = p; ps.focus(); }
  });
});

// Schedule modal wiring
document.getElementById('eeroNewScheduleBtn')?.addEventListener('click', () => openSchedModal(null));
document.getElementById('eeroSchedSaveBtn')?.addEventListener('click', saveSchedFromModal);
document.getElementById('eeroSchedCancelBtn')?.addEventListener('click', closeSchedModal);
document.getElementById('eeroSchedDeleteBtn')?.addEventListener('click', async () => {
  if (!eeroSchedEditingId || !confirm('Delete this schedule?')) return;
  await fetch(`${API}/api/eero/schedules/${encodeURIComponent(eeroSchedEditingId)}`, { method: 'DELETE' });
  closeSchedModal();
  refreshEeroSchedules();
});
document.getElementById('eeroSchedType')?.addEventListener('change', (e) => {
  const isOneOff = e.target.value === 'one-off';
  document.getElementById('eeroSchedRecurringFields').classList.toggle('hidden', isOneOff);
  document.getElementById('eeroSchedOneOffFields').classList.toggle('hidden', !isOneOff);
});

// Bedtime preset: applies 21:00–07:00 weekdays to the first profile, or asks
// which profile if there are several.
// Bedtime preset — pick a kid-flagged device (or prompt for one) and create
// a daily 21:00-07:00 schedule for it. MikroTik-backed, no profiles needed.
document.getElementById('eeroBedtimePresetBtn')?.addEventListener('click', async () => {
  const devices = networkState?.devices || [];
  const kids = devices.filter(d => d.kid);
  if (kids.length === 0) {
    alert('No kid-flagged devices. Tick the kid checkbox on a device under Devices first.');
    return;
  }
  let target;
  if (kids.length === 1) target = kids[0];
  else {
    const choice = prompt(`Bedtime for which kid device?\n${kids.map((d, i) => `${i + 1}) ${d.name || d.hostname || d.mac}`).join('\n')}`);
    const idx = Number(choice) - 1;
    if (isNaN(idx) || !kids[idx]) return;
    target = kids[idx];
  }
  try {
    const res = await fetch(`${API}/api/network/schedules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${target.name || target.mac} bedtime`,
        mac: target.mac,
        days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        start_time: '21:00',
        end_time: '07:00',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    refreshEeroSchedules();
    if (typeof showEeroToast === 'function') showEeroToast(`Bedtime schedule created for ${target.name || target.mac}`);
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
});

// ========== INIT ==========
connectWS();
refreshStatus();
loadTasks();
loadAllSessions();
loadSkillsForAutocomplete();
setInterval(refreshStatus, 10000);
