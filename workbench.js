import {setLogProject} from './live-log.js';
import {normalizeStoryboard} from './narration-contract.js';
import {setHistoryProject, showHistory} from './pi-history.js';

const $ = id => document.getElementById(id);
const running = job => ['running', 'queued'].includes(job?.status);
const time = seconds => { const n = Math.max(0, Math.round(seconds || 0)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`; };
const state = {projects: [], project: null, job: null, version: 0, plan: null, token: 0, drafts: new Map(), sending: new Set(), operations: new Set(), refreshing: new Set(), health: null, pollBusy: false, messageStamp: '', activity: '', videoKey: ''};
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};
async function api(path, options = {}) {
  const response = await fetch(path, options), value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}
const post = (path, value = {}) => api(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
function node(tag, className, content) { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; }
function error(message = '') { $('error-box').textContent = message; $('error-box').hidden = !message; }
function draft(id = state.project?.id) {
  if (!id) return {text: '', images: []};
  if (!state.drafts.has(id)) {
    let saved = {}; try { saved = JSON.parse(storage.get('video-flow.workbench.draft.' + id) || '{}'); } catch {}
    state.drafts.set(id, {text: saved.text || '', messageId: saved.messageId || '', images: [], storyboard: saved.storyboard});
  }
  return state.drafts.get(id);
}
function persistDraft(id = state.project?.id) {
  if (!id) return;
  const d = draft(id); storage.set('video-flow.workbench.draft.' + id, JSON.stringify({text: d.text, messageId: d.messageId, storyboard: d.storyboard}));
}
function mobile(view) {
  $('app-shell').dataset.mobileView = view;
  $('mobile-chat-tab').setAttribute('aria-selected', String(view === 'chat'));
  $('mobile-preview-tab').setAttribute('aria-selected', String(view === 'preview'));
}
const compactSidebar = matchMedia('(max-width:930px)');
function sidebar(open) {
  $('app-shell').classList.toggle('sidebar-open', open);
  $('project-sidebar').inert = compactSidebar.matches && !open;
  $('menu-button').setAttribute('aria-expanded', String(open));
}
compactSidebar.addEventListener('change', () => sidebar($('app-shell').classList.contains('sidebar-open')));
document.addEventListener('keydown', event => { if (event.key === 'Escape') sidebar(false); });
sidebar(false);
function projectStatus(project) {
  return {draft: '尚未创作', running: '创作中', queued: '准备中', complete: '已完成', cancelled: '已取消', failed: '待继续', interrupted: '待继续'}[project.status] || '尚未创作';
}
function renderProjects() {
  const query = $('project-search').value.trim().toLowerCase(), filtered = state.projects.filter(p => p.title.toLowerCase().includes(query));
  $('project-count').textContent = state.projects.length;
  $('sidebar-empty').hidden = filtered.length > 0;
  $('sidebar-empty').textContent = query ? '没有找到对应项目。' : '你的下一个视频，从一个想法开始。';
  $('project-list').replaceChildren(...filtered.map(p => {
    const row = node('button', 'project-row' + (state.project?.id === p.id ? ' selected' : ''));
    row.setAttribute('aria-current', state.project?.id === p.id ? 'page' : 'false');
    row.append(node('strong', '', p.title), node('i', 'project-dot ' + p.status));
    const meta = node('span', 'row-meta'); meta.append(node('span', '', projectStatus(p)), node('span', '', p.latestVersion ? `v${p.latestVersion} · ${p.turns} 轮` : '新项目')); row.append(meta);
    row.addEventListener('click', () => loadProject(p.id).catch(e => error(e.message))); return row;
  }));
}
async function refreshProjects() { state.projects = await api('/api/projects'); renderProjects(); }
const phases = {design: '准备创作', environment: '准备项目工程与会话', agent: 'AI 正在开发视频', acceptance: '检查工程与代表帧', 'project-export': '渲染完整视频', snapshot: '保存视频版本', complete: '创作完成'};
function renderTask() {
  const job = state.job, active = running(job), pending = ['failed', 'cancelled', 'interrupted'].includes(job?.status);
  $('task-banner').hidden = !active && !pending;
  $('task-spinner').hidden = !active;
  $('task-title').textContent = active ? phases[job.phase] || '正在创作' : '创作已暂停';
  $('task-detail').textContent = active ? [`第 ${job.progress?.round || 1} 轮`, state.activity || '工程与对话会自动保存，可以切换项目或关闭页面。'].join(' · ') : job?.error || '已保留工程和会话，可以继续。';
  $('cancel-task').hidden = !active; $('resume-task').hidden = !pending;
  $('cancel-task').disabled = $('resume-task').disabled = state.operations.has(state.project?.id);
  const stage = {design: 0, environment: 0, agent: 1, acceptance: 2, 'project-export': 3, snapshot: 3, complete: 4}[job?.phase] ?? 0;
  [...$('task-stages').children].forEach((el, index) => el.className = 'task-stage' + (index < stage ? ' done' : active && index === stage ? ' current' : ''));
  const bubble = document.querySelector('[data-current-job]');
  if (bubble) { bubble.querySelector('.working-line').lastChild.textContent = phases[job?.phase] || '正在创作'; bubble.querySelector('.working-detail').textContent = $('task-detail').textContent; }
}
function renderComposer() {
  const p = state.project, d = draft(), old = p && state.version && state.version !== p.latestVersion;
  const locked = !p || running(state.job) || state.sending.has(p.id) || state.operations.has(p.id) || old;
  $('message-input').disabled = locked;
  $('attach-images').disabled = locked || p.images.length + d.images.length >= 6;
  $('send-message').disabled = locked || !d.text.trim();
  $('send-label').textContent = state.sending.has(p?.id) ? '提交中…' : p?.awaitingClarification ? '补充说明' : p?.latestVersion ? '调整视频' : '开始创作';
  $('message-input').placeholder = !p ? '先新建一个项目，开始创作…' : p.awaitingClarification ? '补充图片用途或回答问题…' : p.latestVersion ? '描述需要调整的画面、动作或节奏…' : '描述你想做的视频，细节可以交给 AI 决定…';
  $('composer-hint').textContent = old ? '正在查看历史版本，请回到最新版本继续调整。' : running(state.job) ? '创作在后台进行，可以切换项目。' : 'Enter 发送 · Shift + Enter 换行';
  if (d.images.length && !locked) $('composer-hint').textContent += ' · 图片刷新前请发送';
  $('chat-state').textContent = running(state.job) ? '后台持续创作中' : p?.latestVersion ? `已完成 ${p.latestVersion} 个版本` : p ? '从第一条想法开始' : '从想法到成片';
  $('import-storyboard').disabled = locked || Boolean(p?.latestVersion);
  const storyboard = d.storyboard !== undefined ? d.storyboard : p?.storyboard;
  $('clear-storyboard').hidden = !storyboard || Boolean(p?.latestVersion); $('clear-storyboard').disabled = locked;
  $('upload-audio').disabled = locked || !p?.latestVersion || !state.health?.ffmpeg;
  $('storyboard-info').textContent = storyboard ? `${storyboard.title || '解说时间轴'} · ${time(storyboard.durationSec)} · ${storyboard.scenes.length} 个片段${p?.latestVersion ? '，时间轴已锁定。' : '，随下一条消息提交。'}` : '可选。导入已有解说稿和字幕时间轴，与下一条创作消息一起提交。';
  $('audio-info').textContent = p?.video?.audioAvailable ? '已添加配音。新版本时长相同时可继续复用。' : p?.latestVersion ? '配音时长应与视频一致，允许 0.5 秒误差。' : '生成成片后，可以上传配音音频。';
  $('composer-attachments').hidden = !d.images.length;
  $('composer-attachments').replaceChildren(...d.images.map((image, index) => {
    const chip = node('div', 'attachment-chip'), img = node('img'); img.src = image.dataUrl; img.alt = image.name;
    const remove = node('button', '', '×'); remove.type = 'button'; remove.disabled = locked; remove.setAttribute('aria-label', '移除 ' + image.name);
    remove.onclick = () => { d.images.splice(index, 1); d.messageId = ''; persistDraft(); renderComposer(); };
    chip.append(img, node('span', '', image.name), remove); return chip;
  }));
}
function renderMessages(force = false) {
  const p = state.project;
  $('chat-empty').hidden = Boolean(p); $('message-list').hidden = !p;
  if (!p) return;
  const stamp = JSON.stringify(p.messages) + (running(state.job) ? state.job.jobId : '');
  if (!force && stamp === state.messageStamp) return;
  state.messageStamp = stamp;
  const scroll = $('chat-scroll'), following = force || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  $('message-list').replaceChildren(...p.messages.map(m => {
    const active = m.jobId === state.job?.jobId && running(state.job) && m.role === 'assistant';
    const row = node('article', 'message ' + m.role + ' ' + m.kind), avatar = node('div', 'avatar', m.role === 'user' ? '你' : 'V');
    const body = node('div', 'message-body'), meta = node('div', 'message-meta');
    meta.append(node('span', '', m.role === 'user' ? '你' : m.kind === 'notice' ? '工作台' : '创作助手'), node('time', '', new Date(m.createdAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}))); body.append(meta);
    if (active) {
      row.dataset.currentJob = 'true'; const line = node('div', 'working-line'); line.append(node('i', 'spinner'), node('span', '', '正在创作')); body.append(line, node('span', 'working-detail'));
    } else body.append(node('div', 'message-content', m.content));
    if (m.attachments?.length) {
      const attachments = node('div', 'message-attachments');
      for (const a of m.attachments) { const img = node('img'); img.src = `/api/projects/${p.id}/assets/${a.index}`; img.alt = a.name; img.title = a.name; attachments.append(img); }
      body.append(attachments);
    }
    if (m.version) {
      const card = node('button', 'version-card'), icon = node('span', 'version-icon', '▷'), info = node('span');
      const version = p.versions.find(v => v.version === m.version);
      info.append(node('strong', '', `视频第 ${m.version} 版`), node('small', '', `${time(version?.durationSec)} · ${version?.aspectRatio || ''} · 点击查看成片`)); card.append(icon, info, node('span', 'arrow', '↗'));
      card.onclick = () => { mobile('preview'); viewVersion(m.version).catch(e => error(e.message)); }; body.append(card);
    }
    if (m.role === 'assistant' && m.jobId) {
      const historyLink = node('button', 'quiet message-history-link', '查看 pi 执行历史 →');
      historyLink.onclick = () => showHistory(); body.append(historyLink);
    }
    row.append(avatar, body); return row;
  }));
  renderTask(); if (following) requestAnimationFrame(() => scroll.scrollTop = scroll.scrollHeight);
}
function renderAssets() {
  const images = state.project?.images || []; $('asset-empty').hidden = images.length > 0;
  $('project-assets').replaceChildren(...images.map(image => { const item = node('div', 'asset-item'), img = node('img'); img.src = image.url; img.alt = image.name; item.append(img, node('small', '', image.name)); return item; }));
}
function renderPlan() {
  const plan = state.plan, p = state.project;
  $('version-select').replaceChildren(...(p?.versions.length ? [...p.versions].reverse().map(v => { const opt = node('option', '', `第 ${v.version} 版${v.version === p.latestVersion ? ' · 最新' : ''}`); opt.value = v.version; return opt; }) : [node('option', '', '暂无版本')]));
  $('version-select').disabled = !p?.versions.length; $('version-select').value = state.version || '暂无版本';
  $('video-preview').hidden = !plan; $('preview-empty').hidden = Boolean(plan); $('download-actions').hidden = !plan;
  $('old-version-note').hidden = !plan || state.version === p.latestVersion;
  $('video-title').textContent = plan?.title || '等待第一个作品';
  const media = plan?.acceptance?.media?.streams?.[0];
  $('video-meta').textContent = plan ? [time(plan.durationSec), plan.aspectRatio, '30 fps', media ? `${media.width} × ${media.height}` : ''].filter(Boolean).join(' · ') : '';
  $('plan-direction').textContent = plan ? [plan.style, plan.direction].filter(Boolean).join('\n') : '';
  if (plan) {
    const base = `/api/projects/${p.id}/versions/${state.version}`;
    $('download-video').href = base + '/video'; $('download-video').download = `${plan.title}-v${state.version}.mp4`;
    $('download-source').href = base + '/source';
    const key = `${p.id}/${state.version}/${plan.sourceHash}/${p.video?.audioAvailable}`;
    if (key !== state.videoKey) { state.videoKey = key; $('video-preview').src = base + '/video?revision=' + encodeURIComponent(key); $('video-preview').load(); }
  } else if (state.videoKey) { state.videoKey = ''; $('video-preview').pause(); $('video-preview').removeAttribute('src'); $('video-preview').load(); }
  let cursor = 0;
  $('scene-list').replaceChildren(...(plan?.scenes?.length ? plan.scenes.map((scene, i) => {
    const start = cursor; cursor += scene.durationSec; const row = node('button', 'scene-row'), text = node('span');
    text.append(node('strong', '', scene.headline || `片段 ${i + 1}`), node('small', '', `${time(start)} — ${time(cursor)}${scene.body ? ' · ' + scene.body : ''}`)); row.append(node('span', 'scene-index', String(i + 1).padStart(2, '0')), text);
    row.onclick = () => { try { $('video-preview').currentTime = start; } catch { error('视频尚未加载完成，请稍后跳转。'); } }; return row;
  }) : [node('p', 'inspector-empty', '创作完成后，可查看分镜并跳转到对应片段。')]));
  const acceptance = plan?.acceptance;
  $('acceptance-items').replaceChildren(...(acceptance?.ok ? [
    '工程完成构建并导出 H.264 成片',
    `媒体规格：${media?.width || '—'} × ${media?.height || '—'} · ${time(plan.durationSec)} · 30 fps`,
    `代表帧检查：${acceptance.frames?.length || 0} 帧，DOM / SVG 文字边界`,
    ...(acceptance.motion ? ['代表帧存在画面变化'] : []),
    ...(acceptance.deterministic ? ['同一帧重复渲染结果一致'] : []),
    `独立工程 · ${acceptance.template} · 第 ${acceptance.round} 轮完成`
  ].map(text => { const el = node('div', 'acceptance-item'); el.append(node('span', 'tick', '✓'), node('span', '', text)); return el; }) : []));
  $('acceptance-note').textContent = acceptance?.ok ? '以上为实际工程检查记录。文字检查不覆盖 Canvas 内部文字；画面、事实与叙事质量仍需观看成片确认。' + (acceptance.visualReview === 'not-configured' ? ' 当前模型未配置图像输入，未进行模型视觉审查。' : ' 图像输入能力不代表已完成视觉审查。') : '创作完成后展示工程的实际交付检查结果。';
  renderComposer();
}
async function viewVersion(version) {
  const p = state.project, token = state.token; if (!p) return;
  state.version = Number(version); renderComposer();
  const plan = state.version === p.latestVersion ? p.video?.plan : (await api(`/api/projects/${p.id}/versions/${version}`)).plan;
  if (token !== state.token || state.version !== Number(version)) return;
  state.plan = plan || null; renderPlan();
}
function renderProject(force = false) {
  const p = state.project;
  $('project-title').textContent = p?.title || '视频工作台';
  $('project-subtitle').textContent = p ? '独立视频工程 · 持久 pi 会话' : '用对话，让想法逐渐成形';
  $('project-subtitle').title = state.job?.piSessionId || p?.piSessionId ? `pi session：${state.job?.piSessionId || p.piSessionId}` : '';
  $('rename-project').hidden = !p;
  renderProjects(); renderMessages(force); renderTask(); renderComposer(); renderAssets();
}
async function loadProject(id) {
  const token = ++state.token; sidebar(false); error(); $('video-preview').pause();
  const p = await api('/api/projects/' + id); if (token !== state.token) return;
  state.project = p; state.job = p.job; state.version = p.latestVersion; state.plan = p.video?.plan || null; state.activity = ''; state.messageStamp = '';
  storage.set('video-flow.workbench.project', id); $('message-input').value = draft(id).text;
  setLogProject(id); setHistoryProject(id); $('download-logs').href = '/api/logs/download?projectId=' + id; $('download-logs').hidden = false;
  renderProject(true); renderPlan(); mobile('chat');
}
async function refreshCurrent() {
  const p = state.project, token = state.token; if (!p || state.refreshing.has(token)) return;
  state.refreshing.add(token);
  try {
    const updated = await api('/api/projects/' + p.id); if (token !== state.token) return;
    const latestSelected = state.version === p.latestVersion || !state.version;
    state.project = updated; state.job = updated.job;
    if (latestSelected) { state.version = updated.latestVersion; state.plan = updated.video?.plan || null; }
    const d = draft(p.id);
    if (d.messageId && !state.sending.has(p.id) && updated.messages.some(m => m.id === d.messageId)) {
      state.drafts.set(p.id, {text: '', images: []}); persistDraft(p.id); $('message-input').value = '';
    }
    renderProject(); renderPlan();
  } finally { state.refreshing.delete(token); }
}
async function sendMessage(event) {
  event.preventDefault(); const p = state.project, d = draft(); if (!p || running(state.job) || !d.text.trim() || state.sending.has(p.id) || state.operations.has(p.id) || state.version && state.version !== p.latestVersion) return;
  d.messageId ||= crypto.randomUUID(); persistDraft(p.id);
  const body = {content: d.text, images: [...d.images], clientMessageId: d.messageId, ...(d.storyboard !== undefined ? {storyboard: d.storyboard} : {})};
  state.sending.add(p.id); error(); renderComposer();
  try {
    await post(`/api/projects/${p.id}/messages`, body);
    state.drafts.set(p.id, {text: '', images: []}); persistDraft(p.id);
    if (state.project?.id === p.id) { $('message-input').value = ''; state.activity = ''; await refreshCurrent(); $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; }
    await refreshProjects();
  } catch(e) { if (state.project?.id === p.id) error(e.message); }
  finally { state.sending.delete(p.id); if (state.project?.id === p.id) { renderComposer(); refreshCurrent().catch(e => error(e.message)); } }
}
async function jobAction(action) {
  const job = state.job, p = state.project; if (!job || state.operations.has(p.id)) return;
  state.operations.add(p.id); error(); renderTask(); renderComposer();
  try { const updated = await post(`/api/jobs/${job.jobId}/${action}`); if (state.project?.id === p.id) { state.job = updated; state.activity = ''; renderProject(); await refreshCurrent(); } await refreshProjects(); }
  catch(e) { if (state.project?.id === p.id) error(e.message); }
  finally { state.operations.delete(p.id); if (state.project?.id === p.id) { renderTask(); renderComposer(); } }
}
async function imageData(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20_000_000) throw new Error('请使用小于 20 MB 的 PNG、JPEG 或 WebP 图片。');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/webp', .9); if (dataUrl.length > 8_000_000) throw new Error('图片压缩后仍然过大，请缩小图片。');
    return {name: file.name.slice(0, 200), dataUrl};
  } finally { bitmap.close(); }
}
$('composer-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', () => { const d = draft(); d.text = $('message-input').value; d.messageId = ''; persistDraft(); renderComposer(); });
$('message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send-message').disabled) $('composer-form').requestSubmit(); } });
$('attach-images').onclick = () => $('image-input').click();
$('image-input').onchange = async () => {
  const p = state.project, token = state.token, files = [...$('image-input').files]; $('image-input').value = ''; if (!p || !files.length) return;
  state.operations.add(p.id); renderComposer();
  try { const d = draft(p.id); if (p.images.length + d.images.length + files.length > 6) throw new Error('一个项目最多使用 6 张图片。'); const images = []; for (const file of files) images.push(await imageData(file)); d.images.push(...images); d.messageId = ''; }
  catch(e) { if (token === state.token) error(e.message); }
  finally { state.operations.delete(p.id); if (token === state.token) renderComposer(); }
};
$('import-storyboard').onclick = () => $('storyboard-input').click();
$('storyboard-input').onchange = async () => {
  const p = state.project, token = state.token, file = $('storyboard-input').files[0]; $('storyboard-input').value = ''; if (!p || !file) return;
  state.operations.add(p.id); renderComposer();
  try { if (file.size > 3_000_000) throw new Error('时间轴文件过大。'); const storyboard = normalizeStoryboard(JSON.parse(await file.text())); const d = draft(p.id); d.storyboard = storyboard; d.messageId = ''; persistDraft(p.id); }
  catch(e) { if (token === state.token) error(e.message); }
  finally { state.operations.delete(p.id); if (token === state.token) renderComposer(); }
};
$('clear-storyboard').onclick = () => { draft().storyboard = state.project.storyboard ? null : undefined; draft().messageId = ''; persistDraft(); renderComposer(); };
$('upload-audio').onclick = () => $('audio-input').click();
$('audio-input').onchange = async () => {
  const p = state.project, token = state.token, file = $('audio-input').files[0]; $('audio-input').value = ''; if (!p || !file) return;
  state.operations.add(p.id); error(); renderComposer(); $('audio-info').textContent = '上传配音并合成视频中…';
  try { if (file.size > 200_000_000) throw new Error('配音不能超过 200 MB。'); await api(`/api/generations/${p.id}/audio`, {method: 'POST', body: file}); await post(`/api/generations/${p.id}/export`); if (token === state.token) { state.videoKey = ''; await refreshCurrent(); } }
  catch(e) { if (token === state.token) error(e.message); }
  finally { state.operations.delete(p.id); if (token === state.token) renderComposer(); }
};
function showNewProject() { $('new-project-error').hidden = true; $('new-project-name').value = ''; $('new-project-dialog').showModal(); }
for (const id of ['new-project','welcome-new-project','mobile-new-project']) $(id).onclick = showNewProject;
$('cancel-new-project').onclick = () => $('new-project-dialog').close();
$('new-project-form').onsubmit = async event => {
  event.preventDefault(); $('confirm-new-project').disabled = true; $('new-project-error').hidden = true;
  try { const p = await post('/api/projects', {title: $('new-project-name').value}); $('new-project-dialog').close(); await refreshProjects(); await loadProject(p.id); $('message-input').focus(); }
  catch(e) { $('new-project-error').textContent = e.message; $('new-project-error').hidden = false; }
  finally { $('confirm-new-project').disabled = false; }
};
$('rename-project').onclick = () => { $('rename-name').value = state.project.title; $('rename-error').hidden = true; $('rename-dialog').dataset.projectId = state.project.id; $('rename-dialog').showModal(); };
$('cancel-rename').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = async event => {
  event.preventDefault(); const id = $('rename-dialog').dataset.projectId; $('confirm-rename').disabled = true;
  try { await post(`/api/projects/${id}/rename`, {title: $('rename-name').value}); $('rename-dialog').close(); await refreshProjects(); if (state.project?.id === id) await refreshCurrent(); }
  catch(e) { $('rename-error').textContent = e.message; $('rename-error').hidden = false; }
  finally { $('confirm-rename').disabled = false; }
};
$('menu-button').onclick = () => sidebar(true); $('sidebar-backdrop').onclick = () => sidebar(false);
$('mobile-chat-tab').onclick = () => mobile('chat'); $('mobile-preview-tab').onclick = () => mobile('preview');
$('project-search').oninput = renderProjects;
$('version-select').onchange = () => viewVersion(Number($('version-select').value)).catch(e => error(e.message));
$('return-latest').onclick = () => viewVersion(state.project.latestVersion).catch(e => error(e.message));
$('resume-task').onclick = () => jobAction('resume'); $('cancel-task').onclick = () => jobAction('cancel');
for (const name of ['storyboard','assets','acceptance']) $('tab-' + name).onclick = () => {
  for (const n of ['storyboard','assets','acceptance']) { $('tab-' + n).setAttribute('aria-selected', String(n === name)); $('panel-' + n).hidden = n !== name; }
};
$('video-preview').addEventListener('error', () => { if (state.plan) error('成片暂时无法加载。可查看项目运行日志，或重新打开该版本。'); });
window.addEventListener('video-flow:log', event => {
  const entry = event.detail; if (!state.project || entry.generationId !== state.project.id || entry.jobId !== state.job?.jobId || !running(state.job)) return;
  state.activity = entry.message; renderTask();
});
setInterval(async () => {
  const p = state.project, job = state.job, token = state.token; if (!p || !running(job) || state.pollBusy) return;
  state.pollBusy = true;
  try { const updated = await api('/api/jobs/' + job.jobId); if (token !== state.token || state.job?.jobId !== job.jobId) return; state.job = updated; renderTask(); renderComposer(); if (!running(updated)) { state.activity = ''; await refreshCurrent(); await refreshProjects(); } }
  catch(e) { if (token === state.token) error(e.message); }
  finally { state.pollBusy = false; }
}, 1500);
setInterval(() => { refreshProjects().catch(e => error(e.message)); if (state.project && !running(state.job) && !state.operations.has(state.project.id)) refreshCurrent().catch(e => error(e.message)); }, 10000);
async function initialize() {
  const results = await Promise.allSettled([api('/api/health'), refreshProjects()]);
  if (results[0].status === 'fulfilled') {
    state.health = results[0].value; const h = state.health;
    $('model-pill').lastChild.textContent = `${h.pi ? 'pi' : 'pi 未安装'} · ${h.model || '未配置模型'}`;
    $('model-pill').title = h.mode !== 'ai' ? '请在 .env 中配置模型和 API key。' : `${h.provider} · ${h.workflow}`;
    if (h.mode !== 'ai') error('请在 .env 中配置模型供应商和 API key，然后重启服务。');
  } else { $('model-pill').lastChild.textContent = '服务连接失败'; error(results[0].reason.message); }
  if (results[1].status === 'rejected') { error(results[1].reason.message); return; }
  const saved = storage.get('video-flow.workbench.project'), id = state.projects.find(p => p.id === saved)?.id || state.projects[0]?.id;
  if (id) await loadProject(id); else { setLogProject(null); setHistoryProject(null); }
}
initialize().catch(e => error(e.message));
