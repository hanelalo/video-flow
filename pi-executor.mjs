import {spawnIsolated, stopProcess} from './agent-sandbox.mjs';

export class PiExecutor {
  constructor({executable, profile, directory, env, log, sessionFile = directory + '/control/session.jsonl'}) {
    this.log = log; this.pending = new Map(); this.serial = 0; this.closed = false;
    this.usage = {requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0};
    this.child = spawnIsolated(profile, executable, ['--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--tools', 'read,bash,edit,write,grep,find,ls', '--session', sessionFile, '--provider', 'video-flow', '--model', env.VIDEO_FLOW_MODEL, '--append-system-prompt', directory + '/AGENTS.md'], {cwd: directory, env});
    this.processClosed = new Promise(resolve => this.child.once('close', resolve));
    let buffer = '', errors = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16_000_000) { this.fail(new Error('pi 输出记录过大。')); return this.close(); }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, ''); buffer = buffer.slice(at + 1);
        if (!line) continue;
        try { this.event(JSON.parse(line)); } catch (e) { this.fail(new Error('pi RPC 输出无法解析：' + e.message)); this.close(); }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => { this.closed = true; this.fail(new Error(`pi 进程退出（${signal || code}）：${errors.slice(-2000)}`)); });
  }
  fail(error) {
    for (const {reject, timer} of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    if (this.turn) { clearTimeout(this.turn.timer); this.turn.reject(error); this.turn = null; }
  }
  event(event) {
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); event.success ? pending.resolve(event) : pending.reject(new Error(event.error || 'pi 拒绝请求。')); }
    }
    if (this.turn) {
      clearTimeout(this.turn.timer);
      this.turn.timer = setTimeout(() => { this.fail(new Error('pi 长时间没有进展，工程和会话已保存。')); this.close(); }, 900_000);
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const message = event.message;
        this.turn.error = message.stopReason === 'error' || message.errorMessage ? message.errorMessage || '模型请求失败。' : null;
        this.turn.lastText = (message.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (message.usage) {
          this.usage.requests++;
          for (const key of ['input','output','cacheRead','cacheWrite','totalTokens']) this.usage[key] += Number(message.usage[key]) || 0;
          this.log('pi.response', 'pi 收到模型响应', {stopReason: message.stopReason, tokens: message.usage.totalTokens, requests: this.usage.requests});
        }
      }
      if (event.type === 'agent_settled') {
        const turn = this.turn; this.turn = null; clearTimeout(turn.timer);
        if (event.aborted) turn.reject(new Error('pi 本轮开发已中止，工程和会话已保存。'));
        else turn.error ? turn.reject(new Error(turn.error)) : turn.resolve(turn.lastText || '');
      }
    }
    if (event.type === 'tool_execution_start') this.log('pi.tool', `pi 正在使用 ${event.toolName}`, {toolName: event.toolName, toolCallId: event.toolCallId, arguments: event.args});
    if (event.type === 'tool_execution_end') this.log('pi.tool-complete', `${event.toolName} ${event.isError ? '返回错误，交给 pi 修复' : '完成'}`, {toolName: event.toolName, toolCallId: event.toolCallId, durationMs: event.durationMs, isError: event.isError}, event.isError ? 'warn' : 'info');
    if (event.type === 'auto_compaction_start') this.log('pi.compaction', 'pi 正在整理上下文，工程与目标保持不变');
  }
  command(type, fields = {}) {
    if (this.closed) return Promise.reject(new Error('pi 进程已关闭。'));
    const id = 'rpc-' + ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('pi RPC 命令响应超时。')); }, 60_000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, type, ...fields}) + '\n', e => { if (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } });
    });
  }
  async run(message) {
    if (this.turn) throw new Error('pi 已有一轮开发正在进行。');
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    result.catch(() => {});
    // Observe settlement before accepting the prompt; fast turns must not be missed.
    this.turn = {resolve, reject, timer: setTimeout(() => { this.fail(new Error('pi 启动后未开始开发。')); this.close(); }, 60_000)};
    try {
      const accepted = await this.command('prompt', {message});
      if (accepted.data?.disposition === 'handled') this.fail(new Error('pi 提示被扩展处理，没有启动开发。'));
    } catch (e) { this.fail(e); }
    return result;
  }
  close() { this.closed = true; this.fail(new Error('pi 执行器已停止，现场已保存。')); return Promise.all([stopProcess(this.child), this.processClosed]); }
}
