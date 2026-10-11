import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const validId = id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);

export async function createJobStore({ directory, execute, commit, logger, onSettled }) {
  await mkdir(directory, { recursive: true });
  const jobs = new Map(), active = new Map(), generationLocks = new Map(), controllers = new Map();
  async function persist(job) {
    job.updatedAt = new Date().toISOString();
    const temporary = join(directory, `${job.id}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify(job)); await rename(temporary, join(directory, job.id + '.json'));
  }
  for (const name of (await readdir(directory)).filter(n => /^[a-f0-9]{16}\.json$/.test(n))) {
    try {
      const job = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (!validId(job.id) || !validId(job.generationId) || !job.input) throw new Error('任务记录不完整。');
      if (['running', 'queued'].includes(job.status)) { job.autoResume = job.input.engine === 'pi'; job.status = 'interrupted'; job.error = '服务重启，已完成步骤仍保留，可以继续创作。'; await persist(job); }
      jobs.set(job.id, job);
    } catch (e) { logger.log('job.read-failed', '任务记录无法读取', { file: name, reason: e.message }, 'warn'); }
  }
  function get(id) { if (!validId(id) || !jobs.has(id)) { const e = new Error('生成任务不存在。'); e.code = 'ENOENT'; throw e; } return jobs.get(id); }
  function snapshot(job, includeResult = true) {
    return { jobId: job.id, projectId: job.input.projectId, generationId: job.generationId, runId: job.runId, engine: job.input.engine || 'canvas', piSessionId: job.checkpoint?.piSessionId || job.result?.plan?.piSessionId, status: job.status, phase: job.phase, progress: job.progress, title: job.checkpoint?.design?.title || job.input.prompt.slice(0, 40), createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error, ...(includeResult && job.status === 'complete' ? { result: job.result, assistantSummary: job.checkpoint?.lastMessage || '' } : {}) };
  }
  async function start(job) {
    if (active.has(job.id) || job.status === 'complete') return snapshot(job);
    const owner = generationLocks.get(job.generationId);
    if (owner && owner !== job.id) throw new Error('这条作品已有生成任务正在运行，请先查看其进度。');
    generationLocks.set(job.generationId, job.id);
    job.status = 'running'; job.error = ''; job.phase ||= 'design';
    // Reserve before the first await so simultaneous resume calls share one run.
    active.set(job.id, null);
    const controller = new AbortController(); controllers.set(job.id, controller);
    try { await persist(job); } catch (e) { active.delete(job.id); controllers.delete(job.id); generationLocks.delete(job.generationId); job.status = 'failed'; throw e; }
    const log = (event, message, fields = {}, level = 'info') => logger.log(event, message, { jobId: job.id, generationId: job.generationId, runId: job.runId, ...fields }, level);
    log('job.started', '后台创作任务已启动，刷新页面可继续查看');
    const task = Promise.resolve().then(async () => {
      const result = await execute(job.input, log, {
        checkpoint: job.checkpoint,
        async saveCheckpoint(checkpoint, progress) { job.checkpoint = checkpoint; job.phase = progress.phase; job.progress = progress; await persist(job); }
      }, {...job, signal: controller.signal});
      if (controller.signal.aborted) throw new Error('创作已取消，工程和会话已保存。');
      job.result = await commit(job, result, log);
      job.status = 'complete'; job.phase = 'complete'; await persist(job);
      log('job.finished', '后台创作任务已完成', { modules: result.plan.modules?.length || 0 });
    }).catch(async e => {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = e.message || '创作失败。';
      try { await persist(job); } catch (saveError) { log('job.save-failed', '任务状态保存失败', { reason: saveError.message }, 'error'); }
      log('job.failed', '创作中断，已完成步骤可恢复', { reason: job.error, moduleId: e.moduleId, phase: job.phase }, 'error');
    }).finally(async () => { active.delete(job.id); controllers.delete(job.id); if (generationLocks.get(job.generationId) === job.id) generationLocks.delete(job.generationId); try { await onSettled?.(job); } catch(e) { log('workspace.save-failed', '对话状态同步失败，稍后可恢复', {reason: e.message}, 'warn'); } });
    active.set(job.id, task);
    return snapshot(job);
  }
  return {
    isRunning: generationId => generationLocks.has(generationId),
    get: id => snapshot(get(id)),
    input: id => { const j = get(id); return { engine: j.input.engine || 'canvas', prompt: j.input.prompt, images: j.input.images || [], clarificationAnswer: j.input.clarificationAnswer || '', storyboard: j.input.storyboard || j.input.repair?.plan?.storyboard }; },
    list: () => [...jobs.values()].filter(j => j.status !== 'complete').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(j => snapshot(j, false)).slice(0, 50),
    async create(input, generationId, runId, {beforeStart} = {}) {
      if (generationLocks.has(generationId)) throw new Error('这条作品正在创作中，请等待当前任务。');
      const id = randomBytes(8).toString('hex');
      const job = { id, generationId, runId, input, status: 'queued', phase: 'design', progress: { completed: 0, total: 0 }, createdAt: new Date().toISOString(), checkpoint: {} };
      jobs.set(id, job);
      try {
        // Publish the queued task before the conversation references its ID.
        await persist(job);
        if (beforeStart) await beforeStart(id);
        return await start(job);
      } catch (e) {
        job.status = 'failed'; job.error = e.message || '任务启动失败。';
        await persist(job).catch(saveError => logger.log('job.save-failed', '任务启动状态保存失败', {jobId: id, generationId, reason: saveError.message}, 'error'));
        // Submission owns the workspace lock; settle only after it releases it.
        queueMicrotask(() => { Promise.resolve(onSettled?.(job)).catch(error => logger.log('workspace.save-failed', '对话状态同步失败', {jobId: id, generationId, reason: error.message}, 'warn')); });
        throw e;
      }
    },
    resume: id => start(get(id)),
    async cancel(id) { const j = get(id); if (j.status === 'complete') throw new Error('这条创作已经完成。'); controllers.get(id)?.abort(); if (active.has(id)) await active.get(id); else { j.status = 'cancelled'; j.autoResume = false; j.error = '创作已取消，工程和会话已保存。'; await persist(j); } return snapshot(j); },
    async resumePending() { for (const j of jobs.values()) if (j.autoResume && j.status === 'interrupted') { j.autoResume = false; await start(j); } },
    async wait(id) { if (active.has(id)) await active.get(id); const j = get(id); if (j.status !== 'complete') throw new Error(j.error || '任务未完成。'); return j.result; }
  };
}
