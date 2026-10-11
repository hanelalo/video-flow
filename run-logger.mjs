import { mkdir, readFile, appendFile, readdir } from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function redactSecrets(value) {
  let text = String(value);
  for (const secret of [process.env.LLM_API_KEY, process.env.OPENAI_API_KEY].filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]').replace(/((?:\\?["'])?(?:apiKey|api_key|access_token|password|authorization)(?:\\?["'])?\s*[:=]\s*\\?["'])[^"'\n]+/gi, '$1[REDACTED]');
}

export async function createLogger(root) {
  const directory = join(root, 'artifacts', 'logs');
  await mkdir(directory, { recursive: true });
  let entries = [], queue = Promise.resolve();
  const listeners = new Set();
  const file = () => join(directory, `${day()}.jsonl`);
  function redact(value) {
    return JSON.parse(JSON.stringify(value, (key, v) => /^(apiKey|api_key|access_token|password|authorization)$/i.test(key) ? '[REDACTED]' : typeof v === 'string' ? redactSecrets(v).slice(0, 6000) : v));
  }
  async function* savedEntries(projectId) {
    await queue;
    const names = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of names) {
      const stream = createReadStream(join(directory, name)), lines = createInterface({input: stream, crlfDelay: Infinity});
      try {
        for await (const line of lines) {
          let entry; try { entry = JSON.parse(line); } catch { continue; }
          if (!projectId || entry.generationId === projectId || entry.projectId === projectId) yield redact(entry);
        }
      } finally { lines.close(); stream.destroy(); }
    }
  }
  try {
    entries = (await readFile(file(), 'utf8')).trim().split('\n').slice(-200).flatMap(line => {
      try { return [redact(JSON.parse(line))]; } catch { return []; }
    });
  } catch (e) { if (e.code !== 'ENOENT') console.error('读取历史日志失败：', e.code); }
  function log(event, message, fields = {}, level = 'info') {
    const entry = redact({ ...fields, id: randomUUID(), time: new Date().toISOString(), level, event, message });
    entries.push(entry); if (entries.length > 500) entries.shift();
    const line = JSON.stringify(entry);
    (level === 'error' ? console.error : console.log)(line);
    // Keep file order equal to event order. A disk error must not abort creation.
    const target = file();
    queue = queue.then(() => appendFile(target, line + '\n')).catch(e => console.error('写入日志失败：', e.code));
    for (const listener of listeners) { try { listener(entry); } catch { listeners.delete(listener); } }
    return entry;
  }
  return {
    log, file,
    snapshot: () => entries.slice(-200),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async history({projectId, before, limit = 100} = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('日志每页数量须为 1–200。');
      const page = []; let found = !before;
      for await (const entry of savedEntries(projectId)) {
        if (entry.id === before) { found = true; break; }
        page.push(entry); if (page.length > limit + 1) page.shift();
      }
      if (!found) throw new Error('日志游标不存在，请重新加载项目日志。');
      const hasMore = page.length > limit;
      return {entries: page.slice(-limit), before: page.slice(-limit)[0]?.id || null, hasMore};
    },
    async download(projectId) {
      if (projectId) {
        const lines = [];
        for await (const entry of savedEntries(projectId)) lines.push(JSON.stringify(entry));
        return Buffer.from(lines.length ? lines.join('\n') + '\n' : '');
      }
      await queue;
      const bytes = await readFile(file()).catch(e => { if (e.code !== 'ENOENT') throw e; return Buffer.alloc(0); });
      return bytes;
    }
  };
}
