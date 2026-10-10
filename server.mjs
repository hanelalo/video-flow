import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm, mkdir, readdir, access, rename, open, stat, copyFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { makePlan } from './director.mjs';
import { dimensions, MAX_DURATION_SEC } from './video-contract.js';
import { createLogger } from './run-logger.mjs';
import { createJobStore } from './generation-jobs.mjs';
import { hash } from './module-contract.mjs';
import { normalizeStoryboard } from './narration-contract.js';

const root = fileURLToPath(new URL('.', import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const logger = await createLogger(root);
const port = Number(process.env.PORT || 4173), execFile = promisify(execFileCb);
const saved = join(root, 'artifacts', 'generations'), revisions = join(root, 'artifacts', 'revisions');
await mkdir(saved, { recursive: true });
let ffmpegPath, ffprobePath;
try { ffmpegPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
try { ffprobePath = execFileSync('which', ['ffprobe'], { encoding: 'utf8' }).trim(); } catch {}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const validId = id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
function providerConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return { baseUrl, host: new URL(baseUrl).host, apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '', model: process.env.LLM_MODEL || process.env.OPENAI_MODEL || (baseUrl === 'https://api.openai.com/v1' ? 'gpt-4.1-mini' : ''), apiStyle: (process.env.LLM_API_STYLE || 'chat-completions').toLowerCase() };
}
async function readBuffer(req, limit = 90_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('请求数据超过大小上限。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readToFile(req, path, limit = 1_500_000_000) {
  const file = await open(path, 'wx'); let size = 0;
  try { for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('上传文件超过大小上限。'); await file.writeFile(chunk); } } finally { await file.close(); }
  return size;
}
function sendFile(req, res, path, size, type = 'video/mp4') {
  const range = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
  let start = 0, end = size - 1;
  if (range) {
    start = Number(range[1]); end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
  }
  res.writeHead(range ? 206 : 200, { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  const stream = createReadStream(path, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
async function narrationFor(record) {
  const meta = await readFile(join(saved, record.id + '.audio.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  return meta && meta.timelineHash === hash(record.plan.storyboard || { durationSec: record.plan.durationSec }) ? meta : null;
}
async function readJson(req) { return JSON.parse((await readBuffer(req, 12_000_000)).toString() || '{}'); }
async function readRecord(id) { if (!validId(id)) throw new Error('作品编号无效。'); return JSON.parse(await readFile(join(saved, id + '.json'), 'utf8')); }
const jobs = await createJobStore({
  directory: join(root, 'artifacts', 'jobs'), logger,
  async execute(input, log, persistence, job) {
    if (input.repair) {
      const current = await readRecord(job.generationId);
      if (current.jobId === job.id) return { mode: current.mode, plan: current.plan, usage: current.usage };
      if (hash(current.plan) !== input.basePlanHash) throw new Error('作品已有新版本，这个旧任务不能覆盖它。请在最新作品上重新提交反馈。');
    }
    return makePlan(input, providerConfig(), log, persistence);
  },
  async commit(job, result, log) {
    const input = job.input, id = job.generationId;
    if (result.plan.status === 'plan') {
      const previous = await readRecord(id).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      // A crash after the record commit can be resumed without a duplicate revision.
      if (previous?.jobId !== job.id) {
        const record = { id, jobId: job.id, createdAt: new Date().toISOString(), prompt: input.prompt, images: input.images || [], clarificationAnswer: input.clarificationAnswer || '', ...result };
        if (input.repair) {
          if (!previous || hash(previous.plan) !== input.basePlanHash) throw new Error('作品版本已变化，不能提交旧任务。');
          record.revisions = [...(previous.revisions || []), { at: record.createdAt, diagnostics: String(input.repair.diagnostics).slice(0, 5000), plan: previous.plan }];
          await mkdir(revisions, { recursive: true });
          const video = await readFile(join(saved, id + '.mp4')).catch(e => { if (e.code !== 'ENOENT') throw e; });
          if (video) await writeFile(join(revisions, `${id}-v${record.revisions.length}.mp4`), video);
        }
        const temporary = join(saved, `${id}.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(temporary, JSON.stringify(record, null, 2)); await rename(temporary, join(saved, id + '.json'));
      }
      if (input.repair) await rm(join(saved, id + '.mp4'), { force: true });
      result.generationId = id;
    }
    log('plan.complete', result.plan.status === 'clarification' ? '需要确认图片用途' : '完整作品已保存', { status: result.plan.status, modules: result.plan.modules?.length || 0, codeChars: result.plan.renderCode?.length });
    return result;
  }
});
const server = http.createServer(async (req, res) => {
  let directory, context;
  const started = Date.now();
  const requestId = randomBytes(8).toString('hex');
  const runId = /^[a-f0-9-]{1,64}$/i.test(String(req.headers['x-run-id'] || '')) ? req.headers['x-run-id'] : requestId;
  const log = (event, message, fields = {}, level = 'info') => logger.log(event, message, { requestId, runId, ...context, ...fields }, level);
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/jobs') return json(res, 200, jobs.list());
    const jobPath = path.match(/^\/api\/jobs\/([a-f0-9]{16})(\/(?:resume|input))?$/);
    if (jobPath) {
      if (req.method === 'GET' && jobPath[2] === '/input') return json(res, 200, jobs.input(jobPath[1]));
      if (req.method === 'GET' && !jobPath[2]) return json(res, 200, jobs.get(jobPath[1]));
      if (req.method === 'POST' && jobPath[2] === '/resume') return json(res, 202, await jobs.resume(jobPath[1]));
    }
    if (req.method === 'GET' && path === '/api/logs/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
      const send = entry => { if (!res.destroyed) res.write(`id: ${entry.id}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`); };
      for (const entry of logger.snapshot()) send(entry);
      const unsubscribe = logger.subscribe(send), heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); }); return;
    }
    if (req.method === 'GET' && path === '/api/logs') return json(res, 200, logger.snapshot());
    if (req.method === 'GET' && path === '/api/logs/download') {
      const bytes = await logger.download(); res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-length': bytes.length, 'content-disposition': 'attachment; filename="video-flow-logs.jsonl"' }); return res.end(bytes);
    }
    if (req.method === 'POST' && path === '/api/events') {
      const entry = JSON.parse((await readBuffer(req, 12000)).toString());
      const allowed = ['job.start', 'job.complete', 'job.failed', 'validation.start', 'validation.ready', 'validation.complete', 'validation.failed', 'repair.start', 'export.start', 'export.progress', 'export.encoded', 'export.complete', 'preview.failed'];
      if (!allowed.includes(entry.event) || typeof entry.message !== 'string') throw new Error('日志事件格式无效。');
      const fields = { source: 'browser', generationId: validId(entry.generationId) ? entry.generationId : undefined };
      for (const key of ['entrypoint', 'phase', 'moduleId', 'attempt', 'frame', 'frames', 'percent', 'timeSec', 'elapsedMs', 'samples', 'meanRenderMs', 'bytes', 'encoder', 'reason', 'stack']) {
        if (typeof entry[key] === 'number' && Number.isFinite(entry[key])) fields[key] = entry[key];
        else if (typeof entry[key] === 'string') fields[key] = entry[key].slice(0, 3000);
      }
      log(entry.event, entry.message.slice(0, 500), fields, entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/api/health') {
      const c = providerConfig(); return json(res, 200, { mode: c.apiKey ? 'ai' : 'demo', provider: c.host, model: c.model, apiStyle: c.apiStyle, ffmpeg: Boolean(ffmpegPath && ffprobePath), renderer: 'canvas-program', workflow: 'multi-turn-modules' });
    }
    if (req.method === 'POST' && path === '/api/plan') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('创作请求格式无效。');
      const input = { prompt: body.prompt, images: body.images || [], clarificationAnswer: body.clarificationAnswer || '', async: body.async === true, generationId: body.generationId, storyboard: body.storyboard ? normalizeStoryboard(body.storyboard) : undefined };
      if (body.repair) input.repair = { diagnostics: body.repair.diagnostics, moduleId: typeof body.repair.moduleId === 'string' ? body.repair.moduleId : undefined };
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 30000) throw new Error('请填写 1–30000 字的视频想法。');
      if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 6 || input.images.some(i => typeof i?.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(i.dataUrl)))) throw new Error('图片附件格式无效。');
      if (input.repair && (typeof input.repair !== 'object' || Array.isArray(input.repair) || typeof input.repair.diagnostics !== 'string' || input.repair.diagnostics.length > 10000 || !validId(input.generationId))) throw new Error('修改请求需要有效作品编号和反馈描述。');
      if (typeof input.clarificationAnswer !== 'string' || input.clarificationAnswer.length > 5000) throw new Error('图片用途说明过长或格式无效。');
      const generationId = input.repair ? input.generationId : randomBytes(8).toString('hex');
      context = { phase: input.repair ? 'repair' : 'generation', generationId };
      log('plan.start', input.repair ? '开始修改或修复作品' : '开始 AI 创作', { promptChars: input.prompt.length, images: (input.images || []).length });
      if (input.repair) {
        const previous = await readRecord(generationId);
        input.repair.plan = previous.plan; input.storyboard = previous.plan.storyboard; input.basePlanHash = hash(previous.plan);
      }
      const task = await jobs.create(input, generationId, runId);
      if (input.async === true) return json(res, 202, task);
      return json(res, 200, await jobs.wait(task.jobId));
    }
    if (req.method === 'GET' && path === '/api/generations') {
      const records = await Promise.all((await readdir(saved)).filter(n => /^[a-f0-9]{16}\.json$/.test(n)).map(async name => {
        const r = JSON.parse(await readFile(join(saved, name), 'utf8')); return { id: r.id, title: r.plan.title, createdAt: r.createdAt, style: r.plan.style };
      }));
      return json(res, 200, records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50));
    }
    const audioRoute = path.match(/^\/api\/generations\/([a-f0-9]{16})\/audio$/);
    if (audioRoute) {
      const record = await readRecord(audioRoute[1]);
      if (req.method === 'GET') { const info = await narrationFor(record); if (!info) throw new Error('这条作品还没有配音。'); const audioPath = join(saved, record.id + '.audio.m4a'); return sendFile(req, res, audioPath, (await stat(audioPath)).size, 'audio/mp4'); }
      if (req.method === 'POST') {
        if (!ffmpegPath || !ffprobePath) throw new Error('需要 FFmpeg 处理配音。');
        if (jobs.isRunning(record.id)) throw new Error('请等待作品创作完成后添加配音。');
        directory = await mkdtemp(join(tmpdir(), 'video-flow-audio-'));
        const input = join(directory, 'input'), output = join(directory, 'voice.m4a');
        await readToFile(req, input, 200_000_000);
        const { stdout } = await execFile(ffprobePath, ['-v','error','-show_entries','format=duration','-select_streams','a:0','-show_entries','stream=codec_type','-of','json',input], { timeout: 15000 });
        const info = JSON.parse(stdout), durationSec = Number(info.format?.duration);
        if (!info.streams?.length || !Number.isFinite(durationSec) || Math.abs(durationSec - record.plan.durationSec) > .5) throw new Error('配音时长需要与作品时长一致（允许0.5秒误差）。');
        await execFile(ffmpegPath, ['-v','error','-y','-i',input,'-vn','-c:a','aac','-b:a','128k','-ar','48000',output], { timeout: 120000 });
        const latest = await readRecord(record.id), timelineHash = hash(record.plan.storyboard || { durationSec: record.plan.durationSec });
        if (jobs.isRunning(record.id) || timelineHash !== hash(latest.plan.storyboard || { durationSec: latest.plan.durationSec })) throw new Error('配音上传期间时间轴已变化，请重新上传。');
        await copyFile(output, join(saved, record.id + '.audio.m4a'));
        await writeFile(join(saved, record.id + '.audio.json'), JSON.stringify({ durationSec, timelineHash }));
        await rm(join(saved, record.id + '.mp4'), { force: true });
        log('audio.complete','配音已保存，导出时将同步合成',{generationId:record.id,durationSec}); return json(res,200,{durationSec});
      }
    }
    const history = path.match(/^\/api\/generations\/([a-f0-9]{16})(\/video)?$/);
    if (req.method === 'GET' && history) {
      if (!history[2]) { const record = await readRecord(history[1]); record.videoAvailable = await access(join(saved, history[1] + '.mp4')).then(() => true, () => false); record.audioAvailable = Boolean(await narrationFor(record)); return json(res, 200, record); }
      const videoPath = join(saved, history[1] + '.mp4'); return sendFile(req, res, videoPath, (await stat(videoPath)).size);
    }
    if (req.method === 'POST' && path === '/api/render') {
      context = { phase: 'media', generationId: validId(req.headers['x-generation-id']) ? req.headers['x-generation-id'] : undefined };
      log('media.start', '开始封装 MP4');
      const renderId = context.generationId;
      if (renderId && jobs.isRunning(renderId)) throw new Error('作品正在修改，请等待当前创作完成后导出。');
      const sourceHash = renderId ? hash((await readRecord(renderId)).plan.renderCode) : null;
      if (sourceHash && req.headers['x-render-code-hash'] && req.headers['x-render-code-hash'] !== sourceHash) throw new Error('画面程序已有新版本，请重新打开作品再导出。');
      if (!ffmpegPath || !ffprobePath) throw new Error('需要安装 FFmpeg 后重启服务。');
      const expectedDuration = Number(req.headers['x-video-duration']);
      if (!Number.isFinite(expectedDuration) || expectedDuration < 3 || expectedDuration > MAX_DURATION_SEC) throw new Error(`视频时长应为 3–${MAX_DURATION_SEC} 秒。`);
      const { width, height } = dimensions(req.headers['x-video-ratio'], Number(req.headers['x-video-short-side'] || 720));
      const annexB = req.headers['content-type'] === 'video/h264';
      if (!annexB && !String(req.headers['content-type']).startsWith('video/webm')) throw new Error('视频输入格式无效。');
      directory = await mkdtemp(join(tmpdir(), 'video-flow-'));
      const input = join(directory, annexB ? 'frames.h264' : 'recording.webm'), output = join(directory, 'final.mp4');
      const bytes = await readToFile(req, input); if (bytes < 1000) throw new Error('视频数据不完整。');
      const record = renderId ? await readRecord(renderId) : null;
      const audio = record ? await narrationFor(record) : null;
      const chapters = [];
      for (const scene of record?.plan.storyboard?.scenes || []) if (scene.chapter && chapters.at(-1)?.title !== scene.chapter) chapters.push({ title: scene.chapter, start: scene.startSec });
      const metadataPath = join(directory, 'chapters.ffmeta');
      const escapeMetadata = text => String(text).replace(/[\\=;#\n]/g, c => '\\' + c);
      if (chapters.length) await writeFile(metadataPath, ';FFMETADATA1\n' + chapters.map((c, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round((chapters[i + 1]?.start || expectedDuration) * 1000)}\ntitle=${escapeMetadata(c.title)}\n`).join('')); 
      const args = annexB
        ? ['-r', '30', '-f', 'h264', '-i', input, '-c:v', 'copy']
        : ['-i', input, '-vf', 'tpad=stop_mode=clone:stop_duration=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30', '-pix_fmt', 'yuv420p'];
      log('media.ffmpeg', annexB ? 'FFmpeg 封装 H.264 帧流' : 'FFmpeg 转码 WebM', { bytes, width, height, durationSec: expectedDuration });
      await execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args.slice(0, annexB ? 6 : 2), ...(audio ? ['-i', join(saved, renderId + '.audio.m4a')] : []), ...(chapters.length ? ['-f','ffmetadata','-i',metadataPath] : []), ...args.slice(annexB ? 6 : 2), ...(audio ? ['-map','0:v:0','-map','1:a:0','-c:a','copy'] : ['-an']), ...(chapters.length ? ['-map_metadata',String(audio ? 2 : 1),'-map_chapters',String(audio ? 2 : 1)] : []), '-movflags', '+faststart', '-t', String(expectedDuration), output], { timeout: 600_000, maxBuffer: 2_000_000 });
      log('media.probe', '检查成片编码、尺寸、帧率、帧数和时长');
      const { stdout } = await execFile(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames', '-show_entries', 'format=duration', '-of', 'json', output], { timeout: 15_000 });
      const report = JSON.parse(stdout), stream = report.streams?.[0], duration = Number(report.format?.duration);
      const expectedFrames = Number(req.headers['x-video-frames']);
      if (stream?.codec_name !== 'h264' || stream.width !== width || stream.height !== height || stream.r_frame_rate !== '30/1' || !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > .1 || (annexB && Number(stream.nb_frames) !== expectedFrames)) throw new Error('导出文件未通过尺寸、帧率、帧数或时长校验。');
      const size = (await stat(output)).size, id = req.headers['x-generation-id'];
      if (validId(id)) {
        const current = await readRecord(id); if (jobs.isRunning(id) || hash(current.plan.renderCode) !== sourceHash) throw new Error('导出期间作品已变化，请使用最新版本重新导出。');
        const temporary = join(saved, `${id}.${randomBytes(4).toString('hex')}.mp4.tmp`); await copyFile(output, temporary);
        const latest = await readRecord(id);
        if (jobs.isRunning(id) || hash(latest.plan.renderCode) !== sourceHash) { await rm(temporary, { force: true }); throw new Error('导出期间作品已变化，请使用最新版本重新导出。'); }
        await rename(temporary, join(saved, id + '.mp4'));
      }
      log('media.complete', 'MP4 通过媒体校验并保存', { width, height, durationSec: duration, frames: Number(stream.nb_frames), bytes: size, audio: Boolean(audio), elapsedMs: Date.now() - started });
      if (req.headers['x-return-json'] === 'true' && validId(id)) return json(res, 200, { url: `/api/generations/${id}/video`, width, height, durationSec: duration, frames: Number(stream.nb_frames), bytes: size, audio: Boolean(audio) });
      // Stream the committed file: no full-length video copies in Node memory.
      if (!validId(id)) throw new Error('导出需要有效作品编号。');
      return sendFile(req, res, join(saved, id + '.mp4'), size);
    }
    const file = path === '/' ? '/index.html' : path;
    if (req.method !== 'GET' || !['/index.html', '/app.js', '/live-log.js', '/styles.css', '/program-renderer.js', '/video-contract.js', '/narration-contract.js', '/sandbox-frame.html'].includes(file)) { res.writeHead(404); return res.end('Not found'); }
    const body = await readFile(join(root, file.slice(1))); res.writeHead(200, { 'content-type': mime[extname(file)], 'cache-control': 'no-store' }); res.end(body);
  } catch (error) {
    if (req.method === 'POST') log('request.failed', error.message || '请求失败', { reason: error.message, stack: error.stack, elapsedMs: Date.now() - started }, 'error');
    json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message || '操作失败。' });
  } finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
});
server.listen(port, '127.0.0.1', () => logger.log('server.ready', `服务已启动：http://127.0.0.1:${port}`, { logFile: logger.file(), provider: providerConfig().host, model: providerConfig().model, ffmpeg: Boolean(ffmpegPath && ffprobePath) }));
