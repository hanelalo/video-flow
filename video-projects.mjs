import http from 'node:http';
import {mkdir, readFile, writeFile, cp, readdir, lstat, symlink, realpath, access, rm, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {ensureBrowser} from '@remotion/renderer';
import {normalizePlanMetadata} from './plan-metadata.mjs';
import {dimensions} from './video-contract.js';
import {locatePi, prepareSandbox, spawnIsolated, stopProcess} from './agent-sandbox.mjs';
import {PiExecutor} from './pi-executor.mjs';
import {ensureProjectSession, requestMarker, sessionHasRequest} from './project-session.mjs';
import {MIN_NODE_VERSION} from './node-runtime.mjs';

export const TEMPLATE_VERSION = 'remotion-v1';
const run = promisify(execFile), jsonText = v => JSON.stringify(v, null, 2);
const validId = id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
export function projectDirectory(root, generationId, revision) {
  if (!validId(generationId) || !validId(revision)) throw new Error('工程版本编号无效。');
  return join(root, 'artifacts/projects', generationId, revision);
}
export function projectWorkspaceDirectory(root, projectId) {
  if (!validId(projectId)) throw new Error('项目编号无效。');
  return join(root, 'artifacts/projects', projectId, 'workspace');
}
const archiveBase = ['src', 'public', 'project.json', 'AGENTS.md', 'GOAL.md', 'REVIEW.md', 'docs', 'assets.json', 'environment.json', 'package.json', 'package-lock.json', 'render.mjs', 'tsconfig.json', '.video-flow/spec.json'];
async function archiveFiles(directory) {
  const files = [...archiveBase];
  for (const name of ['storyboard.json', 'conversation.json', '.nvmrc']) if (await access(join(directory, name)).then(() => true, () => false)) files.push(name);
  return files;
}
async function saveProjectSnapshot(root, directory, job, result) {
  if (!job.input.projectId) return;
  const target = projectDirectory(root, job.generationId, job.id);
  const existing = await readProjectFile(target, 'revision.json').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (existing) {
    if (existing.jobId !== job.id || existing.result.plan.sourceHash !== result.plan.sourceHash) throw new Error('已发布工程快照与当前任务不一致，不能覆盖旧版本。');
    return;
  }
  const temporary = target + '.snapshot-' + randomBytes(4).toString('hex');
  try {
    if (await sourceHash(directory) !== result.plan.sourceHash) throw new Error('保存版本时源码发生变化，请恢复任务重新验收。');
    for (const file of [...await archiveFiles(directory), 'output/video.mp4', 'output/acceptance.json', 'output/project.tar']) {
      const destination = join(temporary, file);
      await mkdir(join(destination, '..'), {recursive: true});
      await cp(join(directory, file), destination, {recursive: true});
    }
    if (await sourceHash(temporary) !== result.plan.sourceHash) throw new Error('工程快照与已验收源码不一致。');
    await writeFile(join(temporary, 'revision.json'), jsonText({jobId: job.id, projectId: job.input.projectId, result}));
    await rename(temporary, target);
  } finally { await rm(temporary, {recursive: true, force: true}); }
}
export async function projectFiles(directory) {
  const paths = [];
  async function visit(path) {
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`工程源码和素材不能包含链接：${path}`);
    if (info.isDirectory()) for (const name of await readdir(join(directory, path))) await visit(join(path, name));
    else if (info.isFile()) { if (info.size > 200_000_000) throw new Error(`工程文件过大：${path}`); paths.push(path); if (paths.length > 1500) throw new Error('工程文件数量过多。'); }
  }
  for (const path of ['src', 'public', 'project.json']) await visit(path);
  return paths.sort();
}
async function sourceHash(directory) {
  const hash = createHash('sha256');
  for (const path of await projectFiles(directory)) {
    const bytes = await readFile(join(directory, path));
    if (path.startsWith('src/') && bytes.length > 1_000_000) throw new Error(`源码文件过大：${path}`);
    if (path.startsWith('src/') && /(?:from\s*|import\s*\(?\s*)['"][^'"\n]*(?:!|https?:|file:)/.test(bytes.toString())) throw new Error(`源码不允许外部导入或内联构建加载器：${path}`);
    hash.update(path); hash.update(bytes);
  }
  return hash.digest('hex');
}
async function projectPlan(directory, input) {
  const raw = JSON.parse(await readFile(join(directory, 'project.json'), 'utf8'));
  const storyboard = input.storyboard || input.repair?.plan?.storyboard;
  let normalized;
  try { normalized = normalizePlanMetadata({...raw, ...(storyboard ? {durationSec: storyboard.durationSec, scenes: storyboard.scenes} : {})}, input.prompt, input.images.length); }
  catch (error) { throw new Error('project.json 规格无效：' + error.message); }
  normalized.version = '3.0'; normalized.renderer = 'remotion-project'; normalized.storyboard = storyboard;
  const size = dimensions(normalized.aspectRatio, normalized.durationSec > 120 ? 1080 : 720);
  const fps = 30, durationInFrames = Math.round(normalized.durationSec * fps);
  let cursor = 0; const sampleFrames = [];
  for (const scene of normalized.scenes) { sampleFrames.push(Math.min(durationInFrames - 1, Math.round((cursor + scene.durationSec * .5) * fps))); cursor += scene.durationSec; }
  for (let i = 1; i <= 8; i++) sampleFrames.push(Math.floor(durationInFrames * i / 9));
  await writeFile(join(directory, '.video-flow/spec.json'), jsonText({...size, fps, durationInFrames, storyboard: storyboard || null, sampleFrames}));
  return normalized;
}
async function checkEntrypoints(root, directory) {
  for (const name of ['Root.tsx', 'index.ts']) if (!(await readFile(join(directory, 'src', name))).equals(await readFile(join(root, 'templates', TEMPLATE_VERSION, 'src', name)))) throw new Error(`宿主入口 src/${name} 被修改，请恢复模板原文件。`);
}
async function readProjectFile(directory, name) {
  const path = join(directory, name), info = await lstat(path);
  if (!info.isFile() || info.nlink > 1) throw new Error(`工程文件必须是独立普通文件：${name}`);
  return readFile(path, 'utf8');
}
async function createProject(root, directory, input, job) {
  await mkdir(directory, {recursive: true});
  for (const name of ['control/pi', '.video-flow', 'output', 'src', 'public', 'tmp', 'home']) await mkdir(join(directory, name), {recursive: true});
  const exists = await access(join(directory, 'GOAL.md')).then(() => true, () => false);
  const template = join(root, 'templates', TEMPLATE_VERSION);
  if (!exists) {
    await cp(join(template, 'src'), join(directory, 'src'), {recursive: true});
    await cp(join(template, 'docs'), join(directory, 'docs'), {recursive: true});
    for (const name of ['AGENTS.md', 'tsconfig.json', 'render.mjs']) await cp(join(template, name), join(directory, name));
    await cp(join(template, 'tools.mjs'), join(directory, '.video-flow/tools.mjs'));
    const {dependencies, engines} = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const name = 'video-' + job.generationId;
    await writeFile(join(directory, 'package.json'), jsonText({name, version: '0.1.0', private: true, type: 'module', engines, scripts: {render: 'node render.mjs'}, dependencies}));
    await writeFile(join(directory, '.nvmrc'), MIN_NODE_VERSION + '\n');
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    lock.name = name; lock.packages[''].name = name;
    await writeFile(join(directory, 'package-lock.json'), jsonText(lock));
    const dependencyPath = join(directory, 'node_modules');
    if (!await access(dependencyPath).then(() => true, () => false)) await symlink(join(root, 'node_modules'), dependencyPath, 'dir');
    const previous = input.repair?.plan;
    if (previous?.renderer === 'remotion-project') {
      const old = projectDirectory(root, job.generationId, previous.projectRevision);
      await projectFiles(old); // Refuse links before copying a previous revision.
      await cp(join(old, 'src'), join(directory, 'src'), {recursive: true});
      await cp(join(old, 'public'), join(directory, 'public'), {recursive: true});
      await cp(join(old, 'project.json'), join(directory, 'project.json'));
    } else {
      const storyboard = input.storyboard;
      await writeFile(join(directory, 'project.json'), jsonText({title: input.prompt.slice(0, 40), durationSec: storyboard?.durationSec || previous?.durationSec || 15, aspectRatio: previous?.aspectRatio || '16:9', style: '', direction: '', assetUsage: [], scenes: storyboard?.scenes || previous?.scenes || [{id: 'main', durationSec: 15, headline: '原创视频', body: ''}]}));
    }
  }
  const turn = await readFile(join(directory, '.video-flow/turn.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (turn?.jobId === job.id) return;
  await projectFiles(directory);
  // The source and native Pi session remain in place between project messages.
  await rm(join(directory, 'question.json'), {force: true});
  // Host-owned entry points are always taken from this exact template version.
  for (const name of ['Root.tsx', 'index.ts']) await cp(join(template, 'src', name), join(directory, 'src', name));
  const assets = [];
  for (const [index, image] of input.images.entries()) {
    const match = image.dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/s);
    const name = `attachment-${index}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
    await writeFile(join(directory, 'public', name), Buffer.from(match[2], 'base64'));
    assets.push({index, name: image.name, path: name});
  }
  await writeFile(join(directory, 'assets.json'), jsonText(assets));
  if (input.storyboard) await writeFile(join(directory, 'storyboard.json'), jsonText(input.storyboard));
  else await rm(join(directory, 'storyboard.json'), {force: true});
  const dependencies = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies;
  await writeFile(join(directory, 'environment.json'), jsonText({template: TEMPLATE_VERSION, node: process.version, dependencies, generationId: job.generationId, revision: job.id, sessionMode: input.projectId ? 'project' : 'task'}));
  if (input.conversation) await writeFile(join(directory, 'conversation.json'), jsonText(input.conversation));
  await writeFile(join(directory, 'GOAL.md'), `# Video goal\n\n${input.prompt}\n\n${input.conversation ? `## Project conversation\nContinue in this project's persistent Pi session and fixed workspace. Follow the latest user instructions where they revise earlier decisions. conversation.json is an audit copy of the workbench conversation; consult it only if earlier user intent is missing from session context. Keep existing artwork and unfinished work unless the new user request changes it.\n\n## Current user request\n${input.userRequest}\n\n` : ''}## Attachment purpose\n${input.clarificationAnswer || 'Infer the most suitable role; only ask if the image purpose cannot be determined.'}\n\n${input.repair ? `## Revision feedback\n${input.repair.diagnostics}\nPreserve the unaffected creative decisions and timing unless the user requests a change.\n` : ''}\n## Completion\nDeliver original frame-driven artwork, a complete project specification and REVIEW.md. Compilation, sampled layout checks, complete H.264 rendering and media verification must pass. The host checks actual artifacts independently. Respond to the user in Chinese with a concise summary of the changes you actually made. Do not stop merely after planning.\n`);
  await writeFile(join(directory, '.video-flow/turn.json'), jsonText({jobId: job.id, clientMessageId: input.clientMessageId}));
}
async function worker(root, directory, operation, browserPath, log, signal, args = []) {
  if (signal?.aborted) throw new Error('创作已取消。');
  const sandbox = await prepareSandbox({root, directory, renderer: true, browserPath});
  const child = spawnIsolated(sandbox.path, process.execPath, [join(root, 'agent-render-worker.mjs'), directory, operation, browserPath || '', ...args.map(String)], {cwd: directory, env: sandbox.env});
  const abort = () => stopProcess(child); signal?.addEventListener('abort', abort, {once: true});
  let buffer = '', result, stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr = (stderr + c).slice(-8000); });
  child.stdout.on('data', c => {
    buffer += c; let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { const data = JSON.parse(line); if (data.type === 'result') result = data; else if (data.type === 'progress') log('project.progress', operation === 'export' ? `视频导出 ${data.percent}%` : `画面检查 ${data.completed}/${data.total}`, data); } catch {}
    }
  });
  const timeout = setTimeout(() => stopProcess(child), operation === 'export' ? 7_200_000 : 600_000);
  try {
    const [code] = await once(child, 'exit');
    if (signal?.aborted) throw new Error('创作已取消。');
    if (!result) throw new Error(`隔离渲染进程失败（${code}）：${stderr.slice(-4000)}`);
    if (!result.ok && result.error) {
      const error = new Error(result.error);
      if (result.hostEnvironment) {
        error.code = 'HOST_RENDER_ENVIRONMENT';
        log('project.environment-error', '浏览器渲染失败，已保存诊断；停止自动源码重试', {operation, frame: result.frame, stage: result.stage, diagnosticsFile: `output/render-error-${operation}.json`, browserDiagnostics: result.browserDiagnostics}, 'error');
      }
      throw error;
    }
    return result;
  } catch (error) {
    if (error.code === 'HOST_RENDER_ENVIRONMENT' || /bootstrap_check_in[^\n]*Permission denied|sandbox-exec:/.test(error.message)) {
      error.code = 'HOST_RENDER_ENVIRONMENT';
      error.message = /Could not take a screenshot|Unable to capture screenshot/.test(error.message)
        ? '浏览器截图失败，已停止自动源码重试。请查看 output/render-error-' + operation + '.json 的环境诊断：' + error.message
        : '宿主渲染沙箱配置错误，修改视频源码无法解决：' + error.message;
    }
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); await stopProcess(child); }
}
async function requestBody(req) {
  const parts = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 15_000_000) throw new Error('请求过大。'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
async function broker({config, directory, token, tools}) {
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); return res.end(); }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const body = await requestBody(req);
      if (req.url === '/tools') { const result = await tools(body); res.writeHead(200, {'content-type': 'application/json'}); return res.end(JSON.stringify(result)); }
      if (!['/v1/chat/completions', '/v1/responses'].includes(req.url)) { res.writeHead(404); return res.end(); }
      if (body.model !== config.model) throw new Error('工程只能调用已配置的模型。');
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), Number(process.env.LLM_REQUEST_TIMEOUT_MS || 300000));
      res.on('close', () => controller.abort());
      try {
        const endpoint = req.url.endsWith('/responses') ? '/responses' : '/chat/completions';
        if (process.env.LLM_REASONING_EFFORT) {
          if (endpoint === '/responses') body.reasoning = {...body.reasoning, effort: process.env.LLM_REASONING_EFFORT};
          else body.reasoning_effort = process.env.LLM_REASONING_EFFORT;
        }
        const response = await fetch(config.baseUrl.replace(/\/+$/, '') + endpoint, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey}, body: JSON.stringify(body), signal: controller.signal});
        res.writeHead(response.status, {'content-type': response.headers.get('content-type') || 'application/json'});
        for await (const chunk of response.body) if (!res.write(chunk)) await once(res, 'drain');
        res.end();
      } finally { clearTimeout(timer); controllers.delete(controller); }
    } catch (e) { if (!res.headersSent) res.writeHead(400, {'content-type': 'application/json'}); if (!res.destroyed) res.end(JSON.stringify({error: {message: e.message}})); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {port: server.address().port, close: async () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }};
}
export async function executeVideoGoal(input, config, log, persistence, job, root, ffprobePath) {
  if (process.platform !== 'darwin') throw new Error('pi 工程模式目前需要 macOS 隔离执行适配器。');
  if (!config.apiKey || !config.model) throw new Error('pi 视频创作需要配置 LLM_API_KEY 和 LLM_MODEL。');
  if (!['chat-completions', 'responses'].includes(config.apiStyle)) throw new Error('LLM_API_STYLE 只能是 chat-completions 或 responses。');
  if (!ffprobePath) throw new Error('pi 视频创作需要 FFmpeg / FFprobe。');
  const contextWindow = Number(process.env.PI_CONTEXT_WINDOW || 128000), maxTokens = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 16000);
  if (!Number.isInteger(contextWindow) || contextWindow < 4096 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens >= contextWindow) throw new Error('请设置有效的 PI_CONTEXT_WINDOW 与 LLM_MAX_OUTPUT_TOKENS；输出上限应小于上下文窗口。');
  const pi = await locatePi();
  const directory = input.projectId ? projectWorkspaceDirectory(root, input.projectId) : projectDirectory(root, job.generationId, job.id);
  await createProject(root, directory, input, job);
  const checkpoint = persistence.checkpoint; checkpoint.engine = 'pi'; checkpoint.projectRevision = job.id; checkpoint.round ||= 0;
  const save = async (phase, detail = {}) => { checkpoint.phase = phase; await persistence.saveCheckpoint(checkpoint, {phase, round: checkpoint.round, ...detail}); };
  // Older hosts accidentally validated a short Canvas placeholder for every
  // Remotion project. Recheck existing files instead of asking Pi to rewrite them.
  if (checkpoint.feedback === 'AI 没有返回完整的画面程序。' || /bootstrap_check_in[^\n]*Permission denied|Could not take a screenshot because Google Chrome ran out of memory or disk space/.test(checkpoint.feedback || '')) {
    checkpoint.agentSettled = true; delete checkpoint.feedback; delete checkpoint.lastFailedHash; checkpoint.unchanged = 0;
    await save('acceptance');
    log('goal.acceptance-corrected', '已修正宿主校验与渲染环境，直接检查现有 Remotion 工程', {piSessionId: checkpoint.piSessionId});
  }
  if (input.projectId) {
    const snapshot = await readProjectFile(projectDirectory(root, job.generationId, job.id), 'revision.json').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (snapshot) { if (snapshot.jobId !== job.id || snapshot.projectId !== input.projectId) throw new Error('工程快照身份不一致。'); await save('complete'); return snapshot.result; }
  }
  if (checkpoint.acceptedResult) {
    if (await sourceHash(directory) === checkpoint.acceptedResult.plan.sourceHash) {
      await saveProjectSnapshot(root, directory, job, checkpoint.acceptedResult);
      await save('complete'); return checkpoint.acceptedResult;
    }
    delete checkpoint.acceptedResult; checkpoint.agentSettled = false;
    checkpoint.feedback = '保存版本前源码发生变化，请重新检查并交付完整视频。';
  }
  const session = await ensureProjectSession(directory, input.piSessionId || checkpoint.piSessionId);
  checkpoint.piSessionId = session.id;
  const environment = JSON.parse(await readFile(join(directory, 'environment.json'), 'utf8'));
  await writeFile(join(directory, 'environment.json'), jsonText({...environment, piSessionId: session.id}));
  await save('environment');
  log('project.environment', input.projectId ? '继续项目工程与持久 pi 会话，正在准备渲染依赖' : '已创建独立视频工程，正在准备渲染依赖', {revision: job.id, template: TEMPLATE_VERSION, piSessionId: session.id});
  const browserInfo = await ensureBrowser({logLevel: 'error'});
  if (!('path' in browserInfo)) throw new Error('视频渲染浏览器尚未准备好。');
  const browserPath = browserInfo.path;
  // Chromium distribution is inside read-only node_modules by default.
  const token = randomBytes(32).toString('hex');
  let toolBusy = false, acceptingTools = true, pendingTool = Promise.resolve(), executor, service, completedResult;
  const invoke = async ({operation, start = 0, duration = 3}) => {
    if (!['check', 'frames', 'preview'].includes(operation) || !Number.isFinite(start) || !Number.isFinite(duration)) throw new Error('工程工具参数无效。');
    if (toolBusy || !acceptingTools) return {ok: false, error: '当前工程正在验收或已有构建操作，请等待完成。'};
    toolBusy = true;
    let release; pendingTool = new Promise(resolve => { release = resolve; });
    try { await checkEntrypoints(root, directory); await sourceHash(directory); await projectPlan(directory, input); return await worker(root, directory, operation, browserPath, log, job.signal, [start, duration]); }
    catch (e) { return {ok: false, error: e.message, hostEnvironment: e.code === 'HOST_RENDER_ENVIRONMENT'}; }
    finally { toolBusy = false; release(); }
  };
  try {
    service = await broker({config, directory, token, tools: invoke});
    const sandbox = await prepareSandbox({root, directory, pi, brokerPort: service.port});
    const images = process.env.PI_INPUT_IMAGES === 'true';
    const deepseek = new URL(config.baseUrl).hostname === 'api.deepseek.com';
    await writeFile(join(directory, 'control/pi/models.json'), jsonText({providers: {'video-flow': {baseUrl: `http://127.0.0.1:${service.port}/v1`, api: config.apiStyle === 'responses' ? 'openai-responses' : 'openai-completions', apiKey: token, models: [{id: config.model, name: config.model, reasoning: false, input: images ? ['text', 'image'] : ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow, maxTokens, compat: {supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: deepseek}}]}}}));
    executor = new PiExecutor({executable: pi.executable, profile: sandbox.path, directory, sessionFile: session.file, env: {...sandbox.env, VIDEO_FLOW_BROKER: `http://127.0.0.1:${service.port}`, VIDEO_FLOW_PROJECT_TOKEN: token, VIDEO_FLOW_MODEL: config.model}, log});
    const abort = () => executor.close(); job.signal?.addEventListener('abort', abort, {once: true});
    let feedback = checkpoint.feedback || '', unchanged = checkpoint.unchanged || 0;
    try {
      const state = (await executor.command('get_state')).data;
      if (state?.sessionId !== session.id || state?.sessionFile !== session.file) throw new Error('pi 未加载项目的原 session，已停止创作以保留会话。');
      log('pi.session', 'pi 已加载项目会话', {piSessionId: session.id, sessionMessages: state.messageCount});
      for (;;) {
        if (job.signal?.aborted) throw new Error('创作已取消。');
        if (!checkpoint.agentSettled) {
          checkpoint.round++; await save('agent');
          acceptingTools = true;
          log('goal.round', `pi 开始第 ${checkpoint.round} 轮开发`, {round: checkpoint.round, piSessionId: session.id});
          const requestId = input.clientMessageId || job.id, delivered = await sessionHasRequest(session.file, requestId);
          const instruction = `Read the updated GOAL.md, assets.json and project.json. Continue developing this video autonomously in the same workspace and session. The host builds the React component exported from src/Video.tsx and reads project.json; it does not parse your reply as drawing code, require a renderCode field, or require a compact return program. The previous feedback "AI 没有返回完整的画面程序。" was a host bug that is fixed; do not rewrite or compress artwork to satisfy it. Respond with a concise Chinese summary after completing the files. Current runtime tools use the broker in this process's environment; previous broker ports and tokens have expired. ${images ? 'You may read rendered PNGs and attached images.' : 'This model is configured for text input: do not claim image inspection. Use compiler/layout diagnostics and describe this limitation in REVIEW.md.'}`;
          const message = !delivered ? `${requestMarker(requestId)}\n${input.userRequest || input.prompt}\n\nHost execution instructions:\n${instruction}` : `${feedback ? `Host acceptance feedback:\n${feedback}\nFix these problems and continue.` : 'Host resumption: continue the current user request from the saved session and existing files. The user request has already been delivered.'}\n\n${instruction}`;
          checkpoint.lastMessage = (await executor.run(message)).slice(-12000);
          checkpoint.agentSettled = true;
          await save('acceptance');
        }
        acceptingTools = false; await pendingTool;
        const question = await readProjectFile(directory, 'question.json').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (question?.question && input.images.length) return {mode: 'pi', plan: {status: 'clarification', piSessionId: session.id, question: String(question.question).slice(0, 1000)}};
        await save('acceptance');
        let plan, hash;
        try {
          await checkEntrypoints(root, directory); hash = await sourceHash(directory); plan = await projectPlan(directory, input);
          const starter = await readFile(join(root, 'templates', TEMPLATE_VERSION, 'src/Video.tsx'), 'utf8');
          if ((await readFile(join(directory, 'src/Video.tsx'), 'utf8')) === starter) throw new Error('尚未实现原创画面，不能交付模板占位。');
          const review = await readProjectFile(directory, 'REVIEW.md');
          if (review.trim().length < 100) throw new Error('缺少完整的创作与自审说明 REVIEW.md。');
          const frames = await worker(root, directory, 'frames', browserPath, log, job.signal);
          if (!frames.ok) throw new Error('样本画面存在错误：' + JSON.stringify({layout: frames.layout, errors: frames.errors}).slice(0, 10000));
          await save('project-export');
          const media = await worker(root, directory, 'export', browserPath, log, job.signal);
          if (!media.ok) throw new Error('完整导出出现运行错误：' + JSON.stringify(media.errors).slice(0, 10000));
          if (media.layout?.length) throw new Error('完整导出发现文字越界：' + JSON.stringify(media.layout).slice(0, 10000));
          if (!ffprobePath) throw new Error('需要 FFprobe 验收最终视频。');
          const {stdout} = await run(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames', '-show_entries', 'format=duration', '-of', 'json', media.path], {timeout: 30000, signal: job.signal});
          const report = JSON.parse(stdout), stream = report.streams?.[0], size = dimensions(plan.aspectRatio, plan.durationSec > 120 ? 1080 : 720);
          if (stream?.codec_name !== 'h264' || stream.width !== size.width || stream.height !== size.height || stream.r_frame_rate !== '30/1' || Number(stream.nb_frames) !== Math.round(plan.durationSec * 30) || Math.abs(Number(report.format.duration) - plan.durationSec) > .1) throw new Error('成片编码、尺寸、帧数或时长不符合规格。');
          if (hash !== await sourceHash(directory)) throw new Error('验收期间源码发生变化，需要重新检查。');
          const acceptance = {ok: true, sourceHash: hash, template: TEMPLATE_VERSION, piSessionId: session.id, round: checkpoint.round, frames: frames.files.map(f => f.frame), motion: frames.motion, deterministic: frames.deterministic, media: report, visualReview: images ? 'model-capable-unverified' : 'not-configured', acceptedAt: new Date().toISOString()};
          await writeFile(join(directory, 'output/acceptance.json'), jsonText(acceptance));
          await run('/usr/bin/tar', ['-cf', join(directory, 'output/project.tar'), ...await archiveFiles(directory)], {cwd: directory, timeout: 60000});
          completedResult = {mode: 'pi', plan: {...plan, projectRevision: job.id, template: TEMPLATE_VERSION, piSessionId: session.id, sourceHash: hash, acceptance}, usage: {engine: 'pi', rounds: checkpoint.round, sessionRun: executor.usage}};
          checkpoint.acceptedResult = completedResult;
          await save('snapshot');
          break;
        } catch (e) {
          if (job.signal?.aborted) throw e;
          if (e.code === 'HOST_RENDER_ENVIRONMENT') {
            log('goal.environment-failed', '宿主渲染环境不可用，已保留工程并停止无效源码重试', {reason: e.message}, 'error');
            await save('acceptance'); throw e;
          }
          feedback = e.message; checkpoint.feedback = feedback; checkpoint.agentSettled = false;
          const currentHash = await sourceHash(directory).catch(() => 'invalid');
          unchanged = currentHash === checkpoint.lastFailedHash ? unchanged + 1 : 0;
          checkpoint.lastFailedHash = currentHash; checkpoint.unchanged = unchanged;
          log('goal.retry', '验收未通过，反馈给 pi 继续修改', {round: checkpoint.round, reason: feedback}, 'warn');
          await save('agent');
          if (unchanged >= 4) throw new Error('连续多轮没有有效源码进展，工程和会话已保存。最后问题：' + feedback);
        }
      }
    } finally { job.signal?.removeEventListener('abort', abort); }
  } finally { acceptingTools = false; await executor?.close(); await pendingTool; await service?.close(); }
  if (job.signal?.aborted) throw new Error('创作已取消，工程和会话已保存。');
  await saveProjectSnapshot(root, directory, job, completedResult);
  await save('complete');
  return completedResult;
}
