const output = document.getElementById('log-output');
const status = document.getElementById('log-status');
const rows = [], seen = new Set();
let sendQueue = Promise.resolve();
const stream = new EventSource('/api/logs/stream');
stream.onopen = () => { status.textContent = '实时连接'; };
stream.onerror = () => { status.textContent = '连接中断，正在重连…'; };
stream.addEventListener('entry', event => {
  let entry; try { entry = JSON.parse(event.data); } catch { return; }
  if (seen.has(entry.id)) return;
  seen.add(entry.id);
  const following = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  const detail = Object.entries(entry).filter(([key]) => !['id', 'time', 'level', 'message', 'stack'].includes(key)).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' ');
  rows.push({ id: entry.id, text: `[${time}] ${entry.level.toUpperCase()} ${entry.message}\n  ${detail}${entry.stack ? '\n  ' + entry.stack : ''}` });
  if (rows.length > 300) seen.delete(rows.shift().id);
  output.textContent = rows.map(row => row.text).join('\n');
  if (following) output.scrollTop = output.scrollHeight;
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
