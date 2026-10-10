import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export async function createLogger(root) {
  const directory = join(root, 'artifacts', 'logs');
  await mkdir(directory, { recursive: true });
  let entries = [], queue = Promise.resolve();
  const listeners = new Set();
  const file = () => join(directory, `${day()}.jsonl`);
  function redact(value) {
    let text = JSON.stringify(value, (_key, v) => typeof v === 'string' ? v.slice(0, 6000) : v);
    for (const secret of [process.env.LLM_API_KEY, process.env.OPENAI_API_KEY].filter(Boolean)) text = text.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    return JSON.parse(text.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]'));
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
    async download() { await queue; return readFile(file()); }
  };
}
