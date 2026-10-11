import {open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {redactSecrets} from './run-logger.mjs';

const chunkSize = 64 * 1024;
const maxRecordBytes = 16 * 1024 * 1024;
function displayText(value, full) {
  const text = redactSecrets(String(value ?? ''));
  return full || text.length <= 80000 ? text : text.slice(0, 80000) + '\n…内容较长，完整内容可下载执行历史查看。';
}
function normalize(entry, full = false) {
  if (!entry?.id) return null;
  const common = {id: entry.id, timestamp: entry.timestamp};
  if (entry.type === 'compaction') return {...common, role: 'compaction', content: [{type: 'text', text: displayText(entry.summary, full)}]};
  if (entry.type !== 'message' || !['user', 'assistant', 'toolResult'].includes(entry.message?.role)) return null;
  const message = entry.message;
  const blocks = typeof message.content === 'string' ? [{type: 'text', text: message.content}] : message.content || [];
  const content = blocks.flatMap(block => {
    if (block.type === 'text') return [{type: 'text', text: displayText(block.text, full)}];
    if (block.type === 'thinking') return [{type: 'thinking', text: displayText(block.thinking, full)}];
    if (block.type === 'toolCall') return [{type: 'toolCall', id: block.id, name: block.name, arguments: displayText(JSON.stringify(block.arguments ?? {}, null, 2), full)}];
    if (block.type === 'image') return [{type: 'attachment', text: '图片附件'}];
    return [];
  });
  return {...common, role: message.role, toolName: message.toolName, toolCallId: message.toolCallId, isError: Boolean(message.isError), durationMs: message.durationMs, stopReason: message.stopReason, error: message.errorMessage ? displayText(message.errorMessage, full) : undefined, content};
}

// Byte cursors refer to complete JSONL records. Reading older entries never
// loads the whole session, and polling reads only bytes appended since last time.
export async function readProjectHistory(directory, {before, after, limit = 60} = {}) {
  const file = join(directory, 'control/session.jsonl');
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return {sessionId: null, entries: [], before: 0, after: 0, hasMore: false}; throw error; }
  try {
    const size = (await handle.stat()).size;
    if (before !== undefined && after !== undefined) throw new Error('历史游标不能同时指定 before 和 after。');
    for (const cursor of [before, after]) if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > size)) throw new Error('执行历史游标无效，请重新打开项目。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('历史每页数量须为 1–100。');
    const headerBytes = Buffer.alloc(Math.min(size, chunkSize));
    await handle.read(headerBytes, 0, headerBytes.length, 0);
    let header; try { header = JSON.parse(headerBytes.subarray(0, headerBytes.indexOf(10)).toString('utf8')); } catch {}
    const entries = [];
    let oldest = before ?? size, newest = after ?? 0, pending = Buffer.alloc(0), hasMore = false;
    function collect(bytes, start, end) {
      let entry; try { entry = normalize(JSON.parse(bytes.toString('utf8'))); } catch { return; }
      if (!entry) return;
      if (entries.length === limit) { hasMore = true; return; }
      entries.push({...entry, cursor: start}); oldest = Math.min(oldest, start); newest = Math.max(newest, end);
    }
    if (after !== undefined) {
      let position = after, start = after;
      while (position < size && !hasMore) {
        const chunk = Buffer.alloc(Math.min(chunkSize, size - position));
        const {bytesRead} = await handle.read(chunk, 0, chunk.length, position); if (!bytesRead) break;
        position += bytesRead; pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let end;
        while ((end = pending.indexOf(10)) !== -1 && !hasMore) {
          collect(pending.subarray(0, end), start, start + end + 1);
          start += end + 1; pending = pending.subarray(end + 1);
          if (!hasMore) newest = start;
        }
        if (pending.length > maxRecordBytes) throw new Error('pi 会话单条记录过大，无法展示。');
      }
    } else {
      let position = before ?? size, base = position, first = true;
      while (position > 0 && !hasMore) {
        const start = Math.max(0, position - chunkSize), chunk = Buffer.alloc(position - start);
        const {bytesRead} = await handle.read(chunk, 0, chunk.length, start);
        pending = Buffer.concat([chunk.subarray(0, bytesRead), pending]); position = start; base = start;
        let end = pending.length - 1;
        if (first) {
          end = pending.lastIndexOf(10);
          if (end === -1 && position > 0) {
            if (pending.length > maxRecordBytes) throw new Error('pi 会话单条记录过大，无法展示。');
            continue;
          }
          first = false;
        }
        // Ignore an incomplete append at the live end; it will appear next poll.
        while (end >= 0 && !hasMore) {
          const previous = end > 0 ? pending.lastIndexOf(10, end - 1) : -1;
          if (previous === -1 && start > 0) break;
          collect(pending.subarray(previous + 1, end), base + previous + 1, base + end + 1);
          end = previous;
        }
        pending = pending.subarray(0, end + 1);
        if (pending.length > maxRecordBytes) throw new Error('pi 会话单条记录过大，无法展示。');
      }
      entries.reverse();
    }
    return {sessionId: header?.id || null, entries, before: entries.length ? oldest : 0, after: newest, hasMore};
  } finally { await handle.close(); }
}

export async function* exportProjectHistory(directory) {
  const stream = createReadStream(join(directory, 'control/session.jsonl'));
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      let entry; try { entry = normalize(JSON.parse(line), true); } catch { continue; }
      if (entry) yield JSON.stringify(entry) + '\n';
    }
  } finally { lines.close(); stream.destroy(); }
}
