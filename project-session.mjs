import {createReadStream} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';

// One native Pi session file and identity for the lifetime of this workspace.
export async function ensureProjectSession(directory, expectedId) {
  const file = join(directory, 'control/session.jsonl');
  const manifest = join(directory, '.video-flow/session.json');
  const registered = await readFile(manifest, 'utf8').then(JSON.parse).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  let header;
  const stream = createReadStream(file), lines = createInterface({input: stream, crlfDelay: Infinity});
  try { for await (const line of lines) { if (line.trim()) { header = JSON.parse(line); break; } } }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  finally { lines.close(); stream.destroy(); }
  if (!header && (registered || expectedId)) throw new Error('项目的 pi session 文件缺失，请恢复原文件后继续。');
  if (!header) {
    header = {type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory};
    await writeFile(file, JSON.stringify(header) + '\n', {flag: 'wx'});
  }
  if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !header.id || header.cwd !== directory || registered && registered.id !== header.id || expectedId && expectedId !== header.id) throw new Error('项目的 pi session 身份或工作目录不一致，不能自动新建会话覆盖它。');
  if (!registered) await writeFile(manifest, JSON.stringify({id: header.id, file: 'control/session.jsonl'}), {flag: 'wx'});
  return {id: header.id, file};
}

export const requestMarker = id => `[video-flow:user:${id}]`;
export async function sessionHasRequest(file, id) {
  const marker = requestMarker(id), stream = createReadStream(file), lines = createInterface({input: stream, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const content = entry.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
      if (text.includes(marker)) return true;
    }
    return false;
  } finally { lines.close(); stream.destroy(); }
}
