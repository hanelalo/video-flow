import {mkdir, readdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {hash} from './module-contract.mjs';

const id = () => randomBytes(8).toString('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const now = () => new Date().toISOString();
const notice = content => ({id: id(), role: 'assistant', kind: 'notice', content, createdAt: now()});

export async function createWorkspaceStore({directory, readRecord, logger}) {
  await mkdir(directory, {recursive: true});
  const projects = new Map(), locks = new Map();
  async function save(project) {
    const temporary = join(directory, `${project.id}.${id()}.tmp`);
    await writeFile(temporary, JSON.stringify(project));
    await rename(temporary, join(directory, project.id + '.json'));
    projects.set(project.id, project);
  }
  function get(projectId) {
    if (!validId(projectId) || !projects.has(projectId)) { const error = new Error('项目不存在。'); error.code = 'ENOENT'; throw error; }
    return projects.get(projectId);
  }
  async function locked(projectId, action) {
    const previous = locks.get(projectId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => action(structuredClone(get(projectId))));
    locks.set(projectId, next);
    try { return await next; } finally { if (locks.get(projectId) === next) locks.delete(projectId); }
  }
  for (const name of await readdir(directory)) if (/^[a-f0-9]{16}\.json$/.test(name)) {
    try { const project = JSON.parse(await readFile(join(directory, name), 'utf8')); if (!validId(project.id) || !Array.isArray(project.messages)) throw new Error('项目记录无效'); projects.set(project.id, project); }
    catch (e) { logger.log('workspace.read-failed', '项目记录无法读取', {file: name, reason: e.message}, 'warn'); }
  }
  async function settle(job) {
    const projectId = job.input?.projectId || job.projectId;
    if (!projectId || !projects.has(projectId)) return;
    const jobId = job.id || job.jobId;
    return locked(projectId, async project => {
      const message = project.messages.find(m => m.jobId === jobId && m.role === 'assistant');
      if (!message) return;
      const piSessionId = job.checkpoint?.piSessionId || job.piSessionId || job.result?.plan?.piSessionId;
      if (piSessionId) project.piSessionId = piSessionId;
      const latest = [...project.messages].reverse().find(m => m.jobId)?.jobId === jobId;
      const result = job.result;
      if (job.status === 'complete' && result?.plan?.status === 'clarification') {
        message.kind = 'clarification'; message.content = result.plan.question;
        if (latest) project.awaitingClarification = true;
      } else if (job.status === 'complete') {
        const record = await readRecord(projectId);
        message.kind = 'result'; message.version = result?.version || (record.revisions?.length || 0) + 1;
        message.content = (job.checkpoint?.lastMessage || job.assistantSummary || '').trim().slice(0, 4000) || `视频第 ${message.version} 版已生成。可以查看成片，继续描述需要调整的地方。`;
        if (latest && !project.customTitle) project.title = record.plan.title;
        if (latest) project.awaitingClarification = false;
      } else if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
        message.kind = 'error'; message.content = job.error || '创作中断，工程已保存，可以继续。';
      } else { message.kind = 'working'; message.content = '正在根据这轮对话创作视频。'; if (latest) project.activeJobId = jobId; }
      message.status = job.status;
      if (project.activeJobId === jobId && ['complete','failed','cancelled','interrupted'].includes(job.status)) project.activeJobId = '';
      project.updatedAt = now(); await save(project);
    });
  }
  return {
    get,
    list: () => [...projects.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => ({id: p.id, title: p.title, engine: p.engine, createdAt: p.createdAt, updatedAt: p.updatedAt, activeJobId: p.activeJobId, lastJobId: [...p.messages].reverse().find(m => m.jobId)?.jobId, turns: p.messages.filter(m => m.role === 'user').length, latestVersion: Math.max(0,...p.messages.map(m => m.version || 0))})),
    async create({title = ''}) {
      const engine = 'pi';
      if (typeof title !== 'string' || title.length > 80) throw new Error('项目名称无效。');
      const time = now(), project = {id: id(), title: title.trim() || '未命名项目', customTitle: Boolean(title.trim()), engine, sessionMode: 'project', createdAt: time, updatedAt: time, brief: '', images: [], storyboard: null, clarificationAnswer: '', messages: [notice('描述你想做的视频。画面风格、构图、时长和节奏可以交给我决定，也可以明确指定。之后可以在这里继续调整。')], activeJobId: '', awaitingClarification: false};
      await save(project); return project;
    },
    rename(projectId, title) { return locked(projectId, async project => { if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('项目名称需要 1–80 个字符。'); project.title = title.trim(); project.customTitle = true; project.updatedAt = now(); await save(project); return project; }); },
    async submit(projectId, body, jobs, runId) {
      return locked(projectId, async project => {
        const {content, images = [], clientMessageId, storyboard} = body;
        if (typeof clientMessageId !== 'string' || !/^[a-f0-9-]{8,64}$/.test(clientMessageId)) throw new Error('消息编号无效。');
        const existing = project.messages.find(m => m.id === clientMessageId);
        if (existing?.jobId) return {projectId, job: jobs.get(existing.jobId)};
        if (typeof content !== 'string' || !content.trim() || content.length > 30000) throw new Error('请填写 1–30000 字的想法或调整要求。');
        if (jobs.isRunning(projectId)) throw new Error('这个项目正在创作，请等待完成或先取消当前任务。');
        if (!Array.isArray(images) || project.images.length + images.length > 6 || images.some(i => typeof i?.name !== 'string' || i.name.length > 200 || typeof i.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(i.dataUrl) || i.dataUrl.length > 8_000_000)) throw new Error('一个项目最多使用 6 张有效图片。');
        const record = await readRecord(projectId).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (!project.brief) { project.brief = content.trim(); if (!project.customTitle) project.title = content.trim().split('\n')[0].slice(0, 36); }
        const message = {id: clientMessageId, role: 'user', kind: 'message', content: content.trim(), createdAt: now(), attachments: images.map(i => ({name: i.name, index: project.images.length + images.indexOf(i)}))};
        project.images.push(...images); project.messages.push(message);
        if (storyboard !== undefined) { if (record && hash(storyboard) !== hash(record.plan.storyboard || null)) throw new Error('已有作品的解说时间轴已锁定，请在新项目中使用另一份时间轴。'); project.storyboard = storyboard; }
        if (project.awaitingClarification) project.clarificationAnswer = content.trim();
        const conversation = project.messages.filter(m => m.role === 'user' || ['result','clarification','history'].includes(m.kind)).map(m => ({role: m.role, content: m.content, version: m.version}));
        const input = {engine: project.engine, projectId, piSessionId: project.piSessionId, clientMessageId, prompt: project.brief, images: project.images, clarificationAnswer: project.clarificationAnswer || '', storyboard: project.storyboard || undefined, conversation, userRequest: content.trim(), async: true};
        if (record) { input.repair = {plan: record.plan, diagnostics: '用户本轮的调整要求：\n' + content.trim()}; input.basePlanHash = hash(record.plan); }
        const task = await jobs.create(input, projectId, runId, {beforeStart: async jobId => {
          message.jobId = jobId; project.activeJobId = jobId; project.awaitingClarification = false;
          project.messages.push({id: id(), role: 'assistant', kind: 'working', status: 'queued', content: '正在根据这轮对话创作视频。', jobId, createdAt: now()});
          project.updatedAt = now(); await save(project);
        }});
        return {projectId, job: task};
      });
    },
    settle,
    async reconcile(jobs, projectId) {
      for (const project of projectId ? [get(projectId)] : projects.values()) for (const message of project.messages.filter(m => m.role === 'assistant' && m.jobId && ['working','error'].includes(m.kind))) {
        try { const job = jobs.get(message.jobId); if (['complete','failed','cancelled','interrupted'].includes(job.status) && (message.status !== job.status || message.kind === 'working')) await settle(job); }
        catch (e) { if (e.code !== 'ENOENT') logger.log('workspace.sync-failed', '项目任务状态同步失败', {projectId: project.id, reason: e.message}, 'warn'); }
      }
    }
  };
}
