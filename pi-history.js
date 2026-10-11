const $ = id => document.getElementById(id);
const history = {projectId: null, token: 0, entries: new Map(), before: 0, after: 0, hasMore: false, loaded: false, busy: false, following: true, active: false};
function node(tag, className, content) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function details(label, text, className = '') {
  const element = node('details', 'history-detail ' + className);
  element.append(node('summary', '', label), node('pre', '', text)); return element;
}
function record(entry) {
  const article = node('article', 'history-entry history-' + entry.role + (entry.isError || entry.error ? ' history-error' : ''));
  article.dataset.entryId = entry.id;
  const labels = {user: entry.content.some(c => c.text?.includes('[video-flow:user:')) ? '本轮要求' : '验收 / 恢复反馈', assistant: 'pi', toolResult: `${entry.toolName || '工具'} · ${entry.isError ? '错误' : '执行结果'}`, compaction: '上下文整理'};
  const meta = node('div', 'history-meta');
  const date = new Date(entry.timestamp);
  meta.append(node('strong', '', labels[entry.role]), node('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {hour12: false, timeZone: 'Asia/Shanghai'})));
  article.append(meta);
  for (const block of entry.content) {
    if (block.type === 'thinking') article.append(details('思考记录', block.text));
    else if (block.type === 'toolCall') {
      const call = details('调用 ' + block.name, block.arguments, 'history-tool-call');
      // Keep the action visible while long code and tool output stay expandable.
      const preview = node('p', 'history-preview', block.arguments.split('\n').slice(0, 5).join('\n'));
      call.insertBefore(preview, call.lastChild); article.append(call);
    } else if (entry.role === 'toolResult') {
      article.append(node('p', 'history-preview', block.text?.slice(0, 280) || block.text || ''));
      article.append(details('展开执行结果', block.text));
    } else if (entry.role === 'user' || entry.role === 'compaction') article.append(details(entry.role === 'user' ? '展开发送给 pi 的内容' : '展开上下文摘要', block.text));
    else article.append(node('div', 'history-content', block.text));
  }
  if (entry.error) article.append(node('div', 'history-content history-failure', entry.error));
  if (entry.durationMs !== undefined) article.append(node('small', 'history-duration', `${(entry.durationMs / 1000).toFixed(1)} 秒`));
  return article;
}
function controls(message) {
  $('history-load-older').hidden = !history.hasMore;
  $('history-load-older').disabled = history.busy;
  $('history-refresh').disabled = history.busy || !history.projectId;
  $('history-follow').textContent = history.following ? '跟随最新 ✓' : '跟随最新';
  $('history-follow').setAttribute('aria-pressed', String(history.following));
  $('history-status').textContent = message || (history.loaded ? `${history.entries.size} 条已加载记录 · 自动更新` : '正在读取项目会话…');
  $('history-empty').hidden = history.entries.size > 0;
  $('history-empty').textContent = !history.projectId ? '选择项目后查看 pi 执行历史。' : history.loaded ? 'pi 尚未写入执行记录。开始创作后，消息、工具调用和结果会持续保存在这里。' : '正在读取项目的 pi 执行历史…';
  $('history-download').hidden = !history.projectId || !history.entries.size;
  $('history-tab-count').textContent = history.entries.size ? ` (${history.entries.size})` : '';
}
async function load(mode = 'latest') {
  if (!history.projectId || history.busy) return;
  const token = history.token, projectId = history.projectId;
  if (mode === 'older') history.following = false;
  const query = mode === 'older' ? `?before=${history.before}` : mode === 'new' ? `?after=${history.after}` : '';
  history.busy = true; controls();
  try {
    const response = await fetch(`/api/projects/${projectId}/history${query}`), page = await response.json();
    if (!response.ok) throw new Error(page.error || '读取 pi 执行历史失败。');
    if (token !== history.token) return;
    const scroll = $('history-scroll'), height = scroll.scrollHeight, top = scroll.scrollTop, fragment = document.createDocumentFragment();
    for (const entry of page.entries) {
      if (history.entries.has(entry.id)) continue;
      history.entries.set(entry.id, entry); fragment.append(record(entry));
    }
    if (mode === 'older') {
      $('history-list').prepend(fragment); history.before = page.before; history.hasMore = page.hasMore;
    } else {
      $('history-list').append(fragment); history.after = page.after;
      if (!history.loaded) { history.before = page.before; history.hasMore = page.hasMore; }
    }
    history.loaded = true;
    $('history-session').textContent = page.sessionId ? `session ${page.sessionId.slice(0, 8)}` : '尚未建立 pi session';
    $('history-session').title = page.sessionId || '';
    controls();
    if (mode === 'older') scroll.scrollTop = top + scroll.scrollHeight - height;
    else if (history.following) scroll.scrollTop = scroll.scrollHeight;
    if (mode === 'new' && page.hasMore) setTimeout(() => { if (token === history.token) load('new'); }, 0);
  } catch (error) { if (token === history.token) controls(error.message + ' · 点击刷新重试'); }
  finally { if (token === history.token) { history.busy = false; $('history-refresh').disabled = !history.projectId; $('history-load-older').disabled = false; } }
}
export function setHistoryProject(projectId) {
  history.projectId = projectId; history.token++; history.entries.clear(); history.before = history.after = 0;
  history.hasMore = history.loaded = history.busy = false; history.following = true;
  $('history-list').replaceChildren(); $('history-session').textContent = '';
  $('history-download').href = projectId ? `/api/projects/${projectId}/history?download=1` : '#';
  controls(); if (projectId) load();
}
export function showHistory(active = true) {
  history.active = active;
  try { localStorage.setItem('video-flow.workbench.history', active ? 'pi' : 'chat'); } catch {}
  $('chat-scroll').hidden = active; $('pi-history-panel').hidden = !active;
  $('chat-history-tab').setAttribute('aria-selected', String(!active));
  $('pi-history-tab').setAttribute('aria-selected', String(active));
  if (active) load(history.loaded ? 'new' : 'latest');
}
$('chat-history-tab').onclick = () => showHistory(false);
$('pi-history-tab').onclick = () => showHistory();
$('history-load-older').onclick = () => load('older');
$('history-refresh').onclick = () => load(history.loaded ? 'new' : 'latest');
$('history-follow').onclick = () => { history.following = !history.following; controls(); if (history.following) $('history-scroll').scrollTop = $('history-scroll').scrollHeight; };
$('history-scroll').addEventListener('scroll', () => {
  const scroll = $('history-scroll'); history.following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80; controls();
});
setInterval(() => { if (history.active && !document.hidden) load(history.loaded ? 'new' : 'latest'); }, 3000);
try { if (localStorage.getItem('video-flow.workbench.history') === 'pi') showHistory(); } catch {}
