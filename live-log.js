const output = document.getElementById('log-output');
const status = document.getElementById('log-status');
const rows = [], seen = new Set();
let projectRows = [], historyToken = 0, historyBefore = null, historyMore = false, historyBusy = false;
const older = document.getElementById('load-older-logs');
let projectId = undefined;
function visible(entry) { return projectId === undefined || projectId && (entry.generationId === projectId || entry.projectId === projectId); }
function format(entry) {
  const time = new Date(entry.time).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  const detail = Object.entries(entry).filter(([key]) => !['id', 'time', 'level', 'message', 'stack'].includes(key)).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' ');
  return {id: entry.id, entry, text: `[${time}] ${entry.level.toUpperCase()} ${entry.message}\n  ${detail}${entry.stack ? '\n  ' + entry.stack : ''}`};
}
function render() {
  const selected = projectId === undefined ? rows : projectRows;
  output.textContent = selected.map(row => row.text).join('\n') || (projectId ? '这个项目还没有运行日志。' : '选择项目后显示运行日志。');
  if (older) { older.hidden = !historyMore; older.disabled = historyBusy; }
}
function merge(entries, prepend = false) {
  const incoming = entries.map(format), merged = new Map();
  for (const row of prepend ? [...incoming, ...projectRows] : [...projectRows, ...incoming]) merged.set(row.id, row);
  projectRows = [...merged.values()].sort((a,b) => a.entry.time.localeCompare(b.entry.time));
}
async function loadHistory(previous = false) {
  if (!projectId || historyBusy) return;
  const token = historyToken, selectedProject = projectId;
  historyBusy = true; render();
  try {
    const response = await fetch(`/api/logs?projectId=${selectedProject}${previous && historyBefore ? '&before=' + encodeURIComponent(historyBefore) : ''}`);
    const page = await response.json(); if (!response.ok) throw new Error(page.error || '加载项目日志失败。');
    if (token !== historyToken) return;
    const height = output.scrollHeight, top = output.scrollTop;
    merge(page.entries, true); historyBefore = page.before; historyMore = page.hasMore; render();
    output.scrollTop = previous ? top + output.scrollHeight - height : output.scrollHeight;
  } catch (error) { if (token === historyToken) { status.textContent = error.message; if (!projectRows.length) output.textContent = error.message; historyMore = true; } }
  finally { if (token === historyToken) { historyBusy = false; if (older) { older.hidden = !historyMore; older.disabled = false; } } }
}
export function setLogProject(id) {
  projectId = id; historyToken++; historyBefore = null; historyMore = historyBusy = false;
  projectRows = rows.filter(row => visible(row.entry)); render(); if (id) loadHistory();
}
if (older) older.onclick = () => loadHistory(Boolean(historyBefore));
let sendQueue = Promise.resolve();
const stream = new EventSource('/api/logs/stream');
stream.onopen = () => { status.textContent = '实时连接'; };
stream.onerror = () => { status.textContent = '连接中断，正在重连…'; };
stream.addEventListener('entry', event => {
  let entry; try { entry = JSON.parse(event.data); } catch { return; }
  if (seen.has(entry.id)) return;
  seen.add(entry.id);
  const following = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  rows.push(format(entry));
  if (rows.length > 500) seen.delete(rows.shift().id);
  if (visible(entry)) { if (projectId) merge([entry]); render(); if (following) output.scrollTop = output.scrollHeight; }
  window.dispatchEvent(new CustomEvent('video-flow:log', {detail: entry}));
});

// Browser validation and encoding occur outside Node. Forward their milestones
// in order so the same run can be traced in the UI, terminal and saved file.
export function report(event, message, fields = {}, runId = '') {
  sendQueue = sendQueue.then(async () => {
    const response = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-run-id': runId }, body: JSON.stringify({ event, message, ...fields }), keepalive: true });
    if (!response.ok) throw new Error('日志服务返回错误');
  }).catch(error => { status.textContent = '日志上报失败；后续事件将继续尝试'; console.warn('日志上报失败：', error.message); });
  return sendQueue;
}
