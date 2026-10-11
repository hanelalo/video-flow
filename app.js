import { ProgramRenderer } from './program-renderer.js';
import { dimensions } from './video-contract.js';
import { normalizeStoryboard, drawCaptions } from './narration-contract.js';
import { report } from './live-log.js';
const $ = id => document.getElementById(id);
const canvas = $('video-canvas'), renderer = new ProgramRenderer(canvas);
const state = { plan: null, images: [], busy: false, playing: false, valid: false, time: 0, generationId: '', token: 0, chain: Promise.resolve(), health: null, runId: '', jobs: [], storyboard: null, audio: null };
const pendingKey = 'video-flow.pending-job';
const timeText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const isProject = () => state.plan?.renderer === 'remotion-project';
function engineInfo() {
  $('engine-info').textContent = $('engine-select').value === 'canvas' ? 'AI 编写画布程序，可在浏览器中预览和导出。' : !state.health?.pi || !state.health?.sandbox ? '自动开发需要本机 pi 和可用的隔离执行环境。' : '自动设计、开发、检查和导出，过程持续保存。';
}
const phases = { design: '正在设计整条视频', 'repair-selection': '正在定位修改范围', modules: '正在编写画面', module: '正在编写画面', split: '正在细化画面', assemble: '正在合成整条视频', complete: '画面已生成' };
const log = (event, message, fields = {}) => report(event, message, { generationId: state.generationId, ...fields }, state.runId);
Object.assign(phases, {environment: '正在准备独立视频工程', agent: '正在开发视频工程', acceptance: '正在检查实际画面', 'project-export': '正在生成完整视频'});
function error(message = '') { $('error-box').hidden = !message; $('error-box').textContent = message; }
function controls() {
  $('create-button').disabled = state.busy; $('idea').disabled = state.busy; $('clarification-answer').disabled = state.busy;
  $('engine-select').disabled = state.busy;
  $('play-button').disabled = state.busy || !state.valid;
  $('export-button').disabled = state.busy || !state.valid || !state.health?.ffmpeg;
  $('validate-button').disabled = state.busy || !state.plan; $('refine-button').disabled = state.busy || !state.plan; $('refinement').disabled = state.busy;
  $('timeline').disabled = state.busy || !state.plan || isProject();
  $('history-select').disabled = state.busy;
  $('image-input').disabled = state.busy; $('upload-button').disabled = state.busy;
  $('job-select').disabled = state.busy;
  for (const id of ['storyboard-input','clear-storyboard']) $(id).disabled = state.busy;
  $('audio-input').disabled = state.busy || !state.plan;
  const selected = state.jobs.find(j => j.jobId === $('job-select').value);
  $('resume-job').disabled = state.busy || !selected;
  $('resume-job').textContent = selected?.status === 'running' ? '查看进度' : '继续创作';
  $('cancel-job').disabled = !(state.activeJobId || selected?.status === 'running');
  $('play-button').lastElementChild.textContent = state.playing ? '暂停' : '预览动画';
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-run-id': state.runId }, body: JSON.stringify(path === '/api/plan' ? { ...body, async: true } : body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败。'); return data;
}
function showJob(task) {
  const progress = task.progress || {}, text = phases[task.phase] || '正在创作';
  const detail = progress.total ? ` · 已完成 ${progress.completed}/${progress.total}` : progress.round ? ` · 第 ${progress.round} 轮` : '';
  $('job-status').textContent = ['failed','interrupted','cancelled'].includes(task.status) ? `${task.error}（已保存进度）` : `${text}${detail}`;
  if (task.status === 'running') state.activeJobId = task.jobId;
  else if (state.activeJobId === task.jobId) state.activeJobId = '';
  $('cancel-job').disabled = task.status !== 'running';
  if (task.status === 'running') { $('plan-state').textContent = `${text}${detail}`; $('render-state').textContent = '创作继续进行，刷新后可恢复查看'; }
}
async function refreshJobs(preferred = '') {
  state.jobs = await api('/api/jobs'); const selected = preferred || $('job-select').value;
  $('job-select').replaceChildren(new Option(state.jobs.length ? '选择进行中或可继续的创作…' : '没有进行中的创作', ''));
  for (const task of state.jobs) $('job-select').add(new Option(`${task.title} · ${task.status === 'running' ? '进行中' : '可继续'}`, task.jobId));
  if (state.jobs.some(j => j.jobId === selected)) $('job-select').value = selected;
  if (!state.busy && !$('job-select').value) $('job-status').textContent = state.jobs.length ? '选择一条创作查看进度或继续。' : '每一步自动保存，刷新页面可恢复进度。';
  controls();
}
async function waitForJob(task) {
  localStorage.setItem(pendingKey, task.jobId); state.runId = task.runId || state.runId;
  for (;;) {
    showJob(task);
    if (task.status === 'complete') { state.activeJobId = ''; localStorage.removeItem(pendingKey); return task.result; }
    if (['failed','interrupted','cancelled'].includes(task.status)) { state.activeJobId = ''; localStorage.removeItem(pendingKey); throw new Error(task.error || '创作中断，已保存进度。'); }
    await new Promise(resolve => setTimeout(resolve, 1500));
    task = await api(`/api/jobs/${task.jobId}`);
  }
}
async function createPlan(body) { const engine = body.repair ? (isProject() ? 'pi' : 'canvas') : $('engine-select').value; const task = await api('/api/plan', { ...body, engine, storyboard: state.storyboard }); return task.jobId ? waitForJob(task) : task; }
async function attachJob(id, resume = false) {
  const input = await api(`/api/jobs/${id}/input`);
  $('engine-select').value = input.engine || 'canvas';
  engineInfo();
  $('idea').value = input.prompt; $('char-count').textContent = `${input.prompt.length} / 30000`; $('clarification-answer').value = input.clarificationAnswer;
  state.images = input.images; state.storyboard = input.storyboard || null; showStoryboard(); showImages(); state.valid = false;
  const task = await api(`/api/jobs/${id}${resume ? '/resume' : ''}`, resume ? {} : undefined);
  const result = await waitForJob(task);
  if (await acceptResult(result)) { $('clarification').hidden = true; await validateAndRepair(); }
}
async function stop() { $('audio-preview').pause(); $('project-preview').pause(); state.playing = false; state.token++; controls(); await state.chain.catch(() => {}); }
function drawAt(t) {
  if (isProject()) { $('project-preview').currentTime = t; state.time = t; $('time-label').textContent = `${timeText(t)} / ${timeText(state.plan.durationSec)}`; return Promise.resolve(0); }
  state.chain = state.chain.catch(() => {}).then(async () => {
    let ms;
    try { ms = await renderer.render(t); } catch (e) { e.phase = 'drawing'; e.renderTime = t; e.message = `在 ${t.toFixed(3)} 秒绘制失败：${e.message}`; throw e; }
    drawCaptions(canvas.getContext('2d'), state.plan.storyboard, t, canvas.width, canvas.height);
    state.time = t;
    $('timeline').value = t; $('time-label').textContent = `${timeText(t)} / ${timeText(state.plan.durationSec)}`;
    let start = 0; document.querySelectorAll('.scene-card').forEach((card, i) => { const d = state.plan.scenes[i].durationSec; card.classList.toggle('active', t >= start && t < start + d); start += d; });
    return ms;
  }); return state.chain;
}
function validationItem(text, status = 'pass') {
  const div = document.createElement('div'); div.className = `validation-item ${status}`; div.textContent = `${status === 'fail' ? '×' : status === 'note' ? '·' : '✓'} ${text}`; $('validation-items').append(div);
}
function fingerprint() {
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261, visible = 0, luma = 0;
  for (let i = 0; i < pixels.length; i += 4) { for (let c = 0; c < 4; c++) hash = Math.imul(hash ^ pixels[i + c], 16777619); if (pixels[i + 3]) visible++; luma += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3; }
  return { hash: hash >>> 0, visible, luma: luma / (pixels.length / 4) };
}
async function validate() {
  if (isProject()) {
    const report = await api(`/api/generations/${state.generationId}/acceptance`);
    if (!report.ok || report.sourceHash !== state.plan.sourceHash) throw new Error('工程尚未通过当前版本验收。');
    $('validation-items').replaceChildren(); $('validate-button').textContent = '查看验收记录';
    validationItem('独立工程已完成 TypeScript 检查和构建');
    validationItem(`${report.frames.length} 个实际渲染帧通过文字边界检查`);
    if (report.motion && report.deterministic) validationItem('代表帧随时间变化，同一帧重复渲染结果一致');
    validationItem('完整 MP4 已通过编码、尺寸、帧数和时长检查');
    validationItem(report.visualReview === 'not-configured' ? '当前模型未启用图像输入，尚无模型视觉自审' : 'pi 已配置图像输入；画面判断仍需结合实际成片', 'note');
    $('validation-status').textContent = '工程验收通过'; state.valid = true; $('render-state').textContent = '视频已自动生成'; return;
  }
  $('validate-button').textContent = '运行验证';
  const started = performance.now(); log('validation.start', '开始隔离执行与时间采样验证', { phase: 'validation' });
  state.valid = false; controls(); $('validation-items').replaceChildren(); $('validation-status').textContent = '执行画面程序…';
  try {
    const execution = await renderer.load(state.plan, state.images);
    log('validation.ready', execution.entrypoint === 'render-function' ? '已编译并接通完整 render 函数入口' : '已编译画面函数体', { entrypoint: execution.entrypoint });
    validationItem('画面程序已在隔离线程中编译，附件已解码');
    const times = new Set([0, state.plan.durationSec / 2, state.plan.durationSec]); let start = 0;
    for (const scene of state.plan.scenes) { times.add(start + .03); times.add(start + scene.durationSec * .5); times.add(Math.max(0, start + scene.durationSec - .03)); start += scene.durationSec; }
    const transitions = state.plan.moduleDesign?.transitions || [];
    for (const tr of transitions) for (const offset of [-.1, -1/30, 0, 1/30, .1]) times.add(Math.max(0, Math.min(state.plan.durationSec, tr.timeSec + offset)));
    if (transitions.length) log('validation.start', '增加镜头交接窗口前后的画面采样', { phase: 'continuity', samples: transitions.length });
    // Sample inside every second as well as both sides of every scene boundary.
    for (let t = .25; t < state.plan.durationSec; t += .5) times.add(t);
    const signatures = [], timings = [];
    for (const time of [...times].sort((a, b) => a - b)) {
      $('validation-status').textContent = `检查 ${time.toFixed(1)} 秒`; timings.push(await drawAt(time)); signatures.push(fingerprint());
    }
    if (signatures.every(s => !s.visible)) throw new Error('所有采样画面均为透明空白。');
    if (new Set(signatures.map(s => s.hash)).size < 2) throw new Error('整个视频只有同一个静止画面，需要实现随时间变化的动作。');
    validationItem(`${times.size} 个时间点可绘制，包含镜头边界与片尾`);
    if (transitions.length) validationItem(`${transitions.length} 个交接窗口已采样，视觉衔接仍需播放确认`, 'note');
    const repeatedTime = state.plan.durationSec * .413;
    await drawAt(repeatedTime); const first = fingerprint(); await drawAt(0); await drawAt(repeatedTime);
    if (first.hash !== fingerprint().hash) throw new Error('相同时间生成不同画面，程序依赖了历史状态。请用绝对时间与固定种子实现动画。');
    validationItem('随机跳转后同一时间画面一致');
    const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
    validationItem(`画面计算平均 ${mean.toFixed(1)} ms / 帧；导出按固定时间逐帧绘制`, mean > 33 ? 'note' : 'pass');
    if (state.plan.loop && signatures[0].hash !== signatures.at(-1).hash) validationItem('循环首尾画面不完全一致，请播放检查衔接', 'note');
    validationItem(state.health?.ffmpeg ? 'FFmpeg 可用；导出后校验 H.264、尺寸、帧数与时长' : '未安装 FFmpeg，导出不可用', state.health?.ffmpeg ? 'pass' : 'note');
    validationItem('这些检查验证程序可运行，视觉质量仍需看实际视频', 'note');
    state.valid = true; $('validation-status').textContent = '程序验证通过'; $('render-state').textContent = '可以预览 / 导出';
    await drawAt(0);
    log('validation.complete', '画面验证通过', { samples: times.size, meanRenderMs: Number(mean.toFixed(2)), elapsedMs: Math.round(performance.now() - started) });
  } catch (e) { log('validation.failed', '画面验证失败', { level: 'error', reason: e.message, stack: e.stack, moduleId: e.moduleId, timeSec: e.renderTime }); validationItem(e.message.split('\n')[0], 'fail'); $('validation-status').textContent = '执行失败'; throw e; }
}
function displayPlan() {
  const p = state.plan, size = dimensions(p.aspectRatio, p.durationSec > 120 ? 1080 : 720); canvas.width = size.width; canvas.height = size.height;
  $('canvas-wrap').hidden = isProject(); $('project-preview').hidden = !isProject(); $('exported-video').hidden = isProject();
  $('project-download').hidden = !isProject();
  if (isProject()) { renderer.disposeFrame(); $('project-download').href = `/api/generations/${state.generationId}/project`; $('project-download').download = `${p.title}.tar`; }
  else { $('project-preview').removeAttribute('src'); }
  $('canvas-wrap').style.aspectRatio = `${size.width} / ${size.height}`; $('canvas-wrap').style.maxWidth = size.width > size.height ? '100%' : '300px';
  document.querySelector('.export-note').textContent = `MP4 · 30 fps · ${size.width}×${size.height} · 支持逐帧导出`;
  $('canvas-empty').hidden = true; $('empty-state').hidden = true; $('plan-content').hidden = false;
  $('plan-title').textContent = p.title; $('plan-meta').textContent = `${timeText(p.durationSec)} · ${p.aspectRatio} · ${p.scenes.length} 段 · ${p.loop ? '循环' : '完整短片'}`;
  $('plan-direction').textContent = `${p.style}\n${p.direction}`; $('dsl-output').textContent = JSON.stringify(p, null, 2);
  $('plan-state').textContent = isProject() ? '独立视频工程 · 自动完成' : p.modules ? `原创画面 · ${p.modules.length} 个模块` : '原创画面程序'; $('timeline').max = p.durationSec;
  $('scene-list').replaceChildren(); let start = 0;
  p.scenes.forEach((scene, i) => {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'scene-card';
    const title = document.createElement('strong'), body = document.createElement('p');
    title.textContent = `${String(i + 1).padStart(2, '0')} · ${scene.headline}`; body.textContent = `${timeText(start)}–${timeText(start + scene.durationSec)} · ${scene.body}`;
    const time = start; card.append(title, body); card.onclick = async () => { if (state.busy) return; await stop(); drawAt(time).catch(e => error(e.message)); };
    $('scene-list').append(card); start += scene.durationSec;
  });
  if ($('download-link').href.startsWith('blob:')) URL.revokeObjectURL($('download-link').href); $('download-link').removeAttribute('href');
  $('export-result').hidden = true; $('exported-video').pause(); $('exported-video').removeAttribute('src');
}
async function refreshHistory() {
  const current = state.generationId, records = await api('/api/generations');
  $('history-select').replaceChildren(new Option('打开已生成的作品…', ''));
  for (const r of records) $('history-select').add(new Option(`${r.title} · ${new Date(r.createdAt).toLocaleString('zh-CN')}`, r.id));
  $('history-select').value = current;
}
async function acceptResult(result) {
  if (result.plan.status === 'clarification') { $('clarification').hidden = false; $('question-text').textContent = result.plan.question; $('plan-state').textContent = '等待图片用途'; return false; }
  state.plan = result.plan; state.storyboard = result.plan.storyboard || null; showStoryboard(); state.generationId = result.generationId; state.valid = false; state.audio = null; $('audio-preview').removeAttribute('src'); displayPlan(); const saved = await api(`/api/generations/${state.generationId}`); $('audio-info').textContent = saved.audioAvailable ? '已保存配音，预览与导出会同步播放。' : '这条作品暂无配音，可上传同等时长的音频。'; if (saved.audioAvailable) { state.audio = true; $('audio-preview').src = `/api/generations/${state.generationId}/audio`; } if (isProject() && saved.videoAvailable) showProjectVideo(saved.audioAvailable); await refreshHistory(); return true;
}
function showProjectVideo(audio = false) {
  const url = `/api/generations/${state.generationId}/video`, p = state.plan, size = dimensions(p.aspectRatio,p.durationSec>120?1080:720);
  $('project-preview').src = `${url}?v=${Date.now()}`; $('project-preview').loop = p.loop;
  $('download-link').href = url; $('download-link').download = `${p.title}.mp4`; $('export-result').hidden = false;
  $('export-info').textContent = `H.264 · ${size.width}×${size.height} · 30 fps · ${timeText(p.durationSec)}${audio?' · 配音':''}`;
}
async function validateAndRepair(maxRepairs = 2) {
  for (let attempt = 0; ; attempt++) {
    try { await validate(); return; }
    catch (e) {
      if (attempt >= maxRepairs || state.health?.mode !== 'ai' || /隔离.*(?:加载|启动)|OffscreenCanvas is not defined|Worker.*(?:Security|denied)/i.test(e.message)) throw e;
      $('render-state').textContent = `AI 修复 ${attempt + 1}/${maxRepairs}`;
      log('repair.start', '将绘制错误反馈给模型修复', { phase: 'validation', attempt: attempt + 1, reason: e.message });
      const result = await createPlan({ prompt: $('idea').value, images: state.images, clarificationAnswer: $('clarification-answer').value, generationId: state.generationId, repair: { moduleId: e.moduleId, diagnostics: e.message } });
      if (!await acceptResult(result)) throw new Error('修复时需要确认图片用途。');
    }
  }
}
async function job(work, phase = 'operation') {
  if (state.busy) return; await stop(); state.busy = true; state.runId = crypto.randomUUID(); error(); controls();
  log('job.start', '开始运行', { phase, generationId: phase === 'generation' ? undefined : state.generationId });
  try { await work(); log('job.complete', '本次运行完成', { phase }); } catch (e) { log('job.failed', '本次运行失败', { phase, level: 'error', reason: e.message, stack: e.stack }); error(e.message.split('\n')[0]); $('render-state').textContent = '操作失败'; } finally { state.busy = false; await refreshJobs().catch(() => {}); controls(); }
}
$('create-button').onclick = () => job(async () => {
  if (!$('idea').value.trim()) throw new Error('先写一句你想做什么视频。');
  $('plan-state').textContent = 'AI 正在创作画面与运动…'; $('render-state').textContent = '等待新作品'; state.valid = false;
  const result = await createPlan({ prompt: $('idea').value, images: state.images, clarificationAnswer: $('clarification-answer').value });
  if (await acceptResult(result)) { $('clarification').hidden = true; await validateAndRepair(); }
}, 'generation');
$('refine-button').onclick = () => job(async () => {
  const feedback = $('refinement').value.trim(); if (!feedback) throw new Error('写下你想修改的画面或动作。');
  $('render-state').textContent = 'AI 正在调整这条作品…';
  const result = await createPlan({ prompt: $('idea').value, images: state.images, clarificationAnswer: $('clarification-answer').value, generationId: state.generationId, repair: { diagnostics: `用户的创作反馈（不是运行错误）：${feedback}` } });
  if (await acceptResult(result)) { await validateAndRepair(); $('refinement').value = ''; }
}, 'refinement');
$('validate-button').onclick = () => job(() => validateAndRepair(), 'validation');
$('history-select').onchange = () => job(async () => {
  const id = $('history-select').value; if (!id) return;
  const r = await api(`/api/generations/${id}`); $('idea').value = r.prompt; $('char-count').textContent = `${r.prompt.length} / 30000`; $('clarification-answer').value = r.clarificationAnswer; state.images = r.images; state.audio = null; $('audio-info').textContent = r.audioAvailable ? '已保存配音，导出时会同步合成。' : '这条作品暂无配音。'; showImages();
  await acceptResult({ plan: r.plan, generationId: r.id }); await validateAndRepair(0);
  if (r.videoAvailable && !isProject()) { $('exported-video').src = `/api/generations/${id}/video`; $('exported-video').loop = r.plan.loop; $('download-link').href = `/api/generations/${id}/video`; $('download-link').download = `${r.plan.title}.mp4`; $('export-result').hidden = false; $('export-info').textContent = '已保存的 MP4'; }
}, 'restore');
$('job-select').onchange = () => { const task = state.jobs.find(j => j.jobId === $('job-select').value); if (task) showJob(task); controls(); };
$('resume-job').onclick = () => job(async () => {
  const task = state.jobs.find(j => j.jobId === $('job-select').value); if (!task) return;
  await attachJob(task.jobId, task.status !== 'running');
}, 'resume');
$('cancel-job').onclick = async () => { const id = state.activeJobId || $('job-select').value; if (!id) return; try { $('cancel-job').disabled = true; showJob(await api(`/api/jobs/${id}/cancel`, {})); } catch(e) { error(e.message); } };
$('play-button').onclick = async () => {
  if (isProject()) { const video = $('project-preview'); if (video.paused) await video.play().catch(e => error(e.message)); else video.pause(); return; }
  if (state.playing) { await stop(); return; } if (!state.valid || state.busy) return;
  state.playing = true; controls(); if ($('audio-preview').src && state.audio) { $('audio-preview').currentTime = state.time >= state.plan.durationSec ? 0 : state.time; $('audio-preview').play().catch(() => {}); } const token = ++state.token, offset = state.time >= state.plan.durationSec ? 0 : state.time, started = performance.now();
  async function tick() {
    if (token !== state.token || !state.playing) return;
    let time = offset + (performance.now() - started) / 1000;
    if (time >= state.plan.durationSec) { if (state.plan.loop) time %= state.plan.durationSec; else { await drawAt(state.plan.durationSec); await stop(); return; } }
    try { await drawAt(time); } catch (e) { log('preview.failed', '预览绘制失败', { level: 'error', reason: e.message, stack: e.stack, timeSec: e.renderTime }); error(e.message); await stop(); return; }
    if (token === state.token) requestAnimationFrame(tick);
  }
  tick();
};
$('timeline').oninput = async () => { if (state.busy) return; await stop(); drawAt(Number($('timeline').value)).catch(e => error(e.message)); };
$('idea').oninput = () => { $('char-count').textContent = `${$('idea').value.length} / 30000`; $('clarification').hidden = true; $('clarification-answer').value = ''; };
function showStoryboard() {
  $('storyboard-info').textContent = state.storyboard ? `${state.storyboard.title || '解说稿'} · ${state.storyboard.scenes.length} 段 · ${(state.storyboard.durationSec / 60).toFixed(1)} 分钟` : '导入分段时间、解说文案与画面要求，AI 按节奏创作。';
}
$('storyboard-input').onchange = async () => {
  try { const file = $('storyboard-input').files[0]; if (!file) return; if (file.size > 500000) throw new Error('解说时间轴最大500 KB。'); state.storyboard = normalizeStoryboard(JSON.parse(await file.text())); showStoryboard(); error(); }
  catch (e) { error(e.message); } finally { $('storyboard-input').value = ''; }
};
$('clear-storyboard').onclick = () => { state.storyboard = null; showStoryboard(); };
$('audio-input').onchange = () => job(async () => {
  const file = $('audio-input').files[0]; if (!file) return;
  if (file.size > 200000000) throw new Error('配音最大200 MB。');
  const response = await fetch(`/api/generations/${state.generationId}/audio`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-run-id': state.runId }, body: file });
  const info = await response.json(); if (!response.ok) throw new Error(info.error);
  state.audio = true; $('audio-preview').src = `/api/generations/${state.generationId}/audio?v=${Date.now()}`;
  $('audio-info').textContent = `配音已保存 · ${info.durationSec.toFixed(1)} 秒 · 导出时同步合成`;
  $('export-result').hidden = true; $('audio-input').value = '';
  if (isProject()) { await api(`/api/generations/${state.generationId}/export`, {}); showProjectVideo(true); }
}, 'audio');
function showImages() {
  $('image-list').replaceChildren(); state.images.forEach((image, i) => {
    const item = document.createElement('div'); item.className = 'image-chip'; const img = document.createElement('img'); img.src = image.dataUrl; img.alt = image.name;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', `移除 ${image.name}`); button.onclick = () => { if (state.busy) return; state.images.splice(i, 1); state.valid = false; showImages(); controls(); }; item.append(img, button); $('image-list').append(item);
  });
}
$('upload-button').onclick = () => $('image-input').click();
$('image-input').onchange = async () => {
  try {
    for (const file of $('image-input').files) {
      if (state.images.length >= 6) throw new Error('最多添加 6 张图片。'); if (file.size > 6_000_000) throw new Error('每张图片最大 6 MB。');
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      const img = new Image(); img.src = dataUrl; await img.decode(); const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const resized = document.createElement('canvas'); resized.width = Math.round(img.width * scale); resized.height = Math.round(img.height * scale); resized.getContext('2d').drawImage(img, 0, 0, resized.width, resized.height);
      state.images.push({ name: file.name, dataUrl: resized.toDataURL('image/webp', .9) });
    }
    state.valid = false; showImages(); controls(); error();
  } catch (e) { error(e.message); } $('image-input').value = '';
};
async function codecConfig() {
  if (!window.VideoEncoder || !window.VideoFrame) return null;
  for (const codec of ['avc1.420028', 'avc1.640028']) {
    try { const c = { codec, width: canvas.width, height: canvas.height, bitrate: 5_000_000, framerate: 30, avc: { format: 'annexb' } }; if ((await VideoEncoder.isConfigSupported(c)).supported) return c; } catch {}
  }
  return null;
}
async function encodeFrames(config) {
  const chunks = [], parts = [], frames = Math.round(state.plan.durationSec * 30); let bufferedBytes = 0; let encodingError, lastPercent = -1;
  const started = performance.now(); log('export.start', '开始按固定时间逐帧编码', { encoder: 'WebCodecs H.264', frames });
  const encoder = new VideoEncoder({ output: chunk => { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); chunks.push(bytes); bufferedBytes += bytes.length; if (bufferedBytes >= 2000000) { parts.push(new Blob(chunks, { type: 'video/h264' })); chunks.length = 0; bufferedBytes = 0; } }, error: e => { encodingError = e; } });
  try {
    encoder.configure(config);
    for (let i = 0; i < frames; i++) {
      if (encodingError) throw encodingError;
      await drawAt(i / 30); const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1_000_000 / 30), duration: Math.round(1_000_000 / 30) });
      try { encoder.encode(frame, { keyFrame: i % 60 === 0 }); } finally { frame.close(); }
      if (encoder.encodeQueueSize > 8) await encoder.flush();
      $('render-state').textContent = `逐帧渲染 ${i + 1}/${frames}`;
      const percent = Math.floor((i + 1) / frames * 10) * 10;
      if (percent > lastPercent) { lastPercent = percent; log('export.progress', '逐帧编码进度', { frame: i + 1, frames, percent, timeSec: i / 30, elapsedMs: Math.round(performance.now() - started) }); }
    }
    await encoder.flush(); if (encodingError) throw encodingError;
    const blob = new Blob([...parts, ...chunks], { type: 'video/h264' }); log('export.encoded', '全部画面编码完成', { frames, bytes: blob.size, elapsedMs: Math.round(performance.now() - started) });
    return { blob, frames, duration: frames / 30 };
  } finally { if (encoder.state !== 'closed') encoder.close(); }
}
async function recordFallback() {
  log('export.start', '浏览器不支持 H.264 逐帧编码，使用实时录制', { level: 'warn', encoder: 'MediaRecorder' });
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!mime) throw new Error('浏览器既不支持 H.264 逐帧编码，也不支持 WebM 录制。');
  await drawAt(0); const stream = canvas.captureStream(30), chunks = [], recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const finished = new Promise((resolve, reject) => { recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); }; recorder.onstop = resolve; recorder.onerror = e => reject(e.error); });
  try {
    recorder.start(); const started = performance.now(); let lastPercent = -1;
    while (performance.now() - started < state.plan.durationSec * 1000) { const t = (performance.now() - started) / 1000; await drawAt(t); $('render-state').textContent = `兼容录制 ${t.toFixed(1)} 秒`; const percent = Math.floor(t / state.plan.durationSec * 10) * 10; if (percent > lastPercent) { lastPercent = percent; log('export.progress', '兼容录制进度', { percent, timeSec: t }); } await new Promise(resolve => setTimeout(resolve, 15)); }
    recorder.stop(); await finished; const blob = new Blob(chunks, { type: 'video/webm' }); log('export.encoded', '实时录制完成', { bytes: blob.size }); return { blob, frames: Math.round(state.plan.durationSec * 30), duration: state.plan.durationSec };
  } finally { if (recorder.state !== 'inactive') recorder.stop(); stream.getTracks().forEach(t => t.stop()); }
}
$('export-button').onclick = () => job(async () => {
  if (isProject()) { const info = await api(`/api/generations/${state.generationId}/export`, {}); showProjectVideo(info.audio); $('render-state').textContent = 'MP4 已生成'; return; }
  let encoded;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const config = await codecConfig(); $('render-state').textContent = config ? '准备逐帧导出' : '准备兼容录制';
    try { encoded = config ? await encodeFrames(config) : await recordFallback(); break; }
    catch (e) {
      if (e.phase !== 'drawing' || attempt === 2 || state.health?.mode !== 'ai') { if (e.phase === 'drawing') state.valid = false; throw e; }
      $('render-state').textContent = `AI 修复导出画面 ${attempt + 1}/2`;
      log('repair.start', '将逐帧导出错误反馈给模型修复', { phase: 'export', attempt: attempt + 1, reason: e.message, timeSec: e.renderTime });
      const result = await createPlan({ prompt: $('idea').value, images: state.images, clarificationAnswer: $('clarification-answer').value, generationId: state.generationId, repair: { moduleId: e.moduleId, diagnostics: `完整逐帧导出中发现错误：${e.message}` } });
      if (!await acceptResult(result)) throw new Error('修复导出时需要确认图片用途。');
      await validateAndRepair(1);
    }
  }
  $('render-state').textContent = '封装 MP4 并校验媒体…';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state.plan.renderCode));
  const codeHash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  const response = await fetch('/api/render', { method: 'POST', headers: { 'x-run-id': state.runId, 'content-type': encoded.blob.type, 'x-video-duration': String(encoded.duration), 'x-video-ratio': state.plan.aspectRatio, 'x-video-short-side': String(Math.min(canvas.width, canvas.height)), 'x-video-frames': String(encoded.frames), 'x-generation-id': state.generationId, 'x-render-code-hash': codeHash, 'x-return-json': 'true' }, body: encoded.blob });
  if (!response.ok) throw new Error((await response.json()).error);
  const info = await response.json();
  if ($('download-link').href.startsWith('blob:')) URL.revokeObjectURL($('download-link').href);
  $('exported-video').src = `${info.url}?v=${Date.now()}`; $('exported-video').loop = state.plan.loop; $('export-result').hidden = false;
  $('download-link').href = info.url; $('download-link').download = `${state.plan.title.replace(/[\\/:*?"<>|]/g, '-')}.mp4`;
  $('export-info').textContent = `H.264 · ${info.width}×${info.height} · 30 fps · ${info.frames} 帧 · ${timeText(info.durationSec)}${info.audio ? ' · 中文配音' : ''}`;
  $('render-state').textContent = 'MP4 已生成'; log('export.complete', 'MP4 已生成，可播放和下载', { frames: info.frames, bytes: info.bytes }); await drawAt(0);
}, 'export');
(async () => {
  try {
    state.health = await api('/api/health'); $('engine-select').value = state.health.defaultEngine || 'pi'; $('mode-pill').textContent = state.health.mode === 'ai' ? `${state.health.model} · ${state.health.pi ? 'pi 已就绪' : '多轮创作'}` : '演示模式 · 固定样例'; $('local-note').textContent = state.health.mode === 'ai' ? '画面与运动由 AI 编写' : '配置模型后启用 AI 创作';
    engineInfo();
    await refreshHistory(); await refreshJobs();
    const pending = localStorage.getItem(pendingKey);
    if (pending && /^[a-f0-9]{16}$/.test(pending)) {
      const task = await api(`/api/jobs/${pending}`).catch(() => null);
      if (task?.status === 'running' || task?.status === 'complete') await job(() => attachJob(pending), 'resume');
      else { localStorage.removeItem(pendingKey); await refreshJobs(pending); if (task) showJob(task); }
    }
  } catch (e) { error(e.message); } controls();
})();
$('project-preview').addEventListener('play', () => { state.playing = true; controls(); });
$('engine-select').addEventListener('change', engineInfo);
$('project-preview').addEventListener('pause', () => { state.playing = false; controls(); });
$('project-preview').addEventListener('timeupdate', () => { if (isProject()) { state.time = $('project-preview').currentTime; $('time-label').textContent = `${timeText(state.time)} / ${timeText(state.plan.durationSec)}`; } });
