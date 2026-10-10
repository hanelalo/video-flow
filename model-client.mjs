export class TruncatedOutput extends Error {
  constructor() { super('模型输出被截断；当前部分尚未完成。'); this.code = 'OUTPUT_TRUNCATED'; }
}

export function parseObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Accept prose around a complete object, never guess at missing braces.
  let lastError;
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch (e) { lastError = e; } break; }
    }
    // Avoid scanning every brace inside a large malformed module response.
    if (start > 1000) break;
  }
  throw new SyntaxError(lastError?.message || '模型没有返回闭合的 JSON 对象。');
}

export function outputCode(text) {
  return String(text || '').trim().replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export async function requestModel(config, { system, request, images = [], json = false, stage, moduleId, attempt = 1 }, log) {
  const maxTokens = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 48000);
  if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 393216) throw new Error('LLM_MAX_OUTPUT_TOKENS 应为 1024–393216 的整数，且供应商须支持该值。');
  const timeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS || 300000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw new Error('LLM_REQUEST_TIMEOUT_MS 应为 1000–1800000 的整数。');
  const content = [{ type: config.apiStyle === 'responses' ? 'input_text' : 'text', text: request }];
  for (const [index, image] of images.entries()) {
    content.push({ type: config.apiStyle === 'responses' ? 'input_text' : 'text', text: `附件 ${index}：${image.name}` });
    content.push(config.apiStyle === 'responses' ? { type: 'input_image', image_url: image.dataUrl } : { type: 'image_url', image_url: { url: image.dataUrl } });
  }
  const body = config.apiStyle === 'responses'
    ? { model: config.model, store: false, max_output_tokens: maxTokens, instructions: system, input: [{ role: 'user', content }], ...(json ? { text: { format: { type: 'json_object' } } } : {}) }
    : { model: config.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content }], ...(json ? { response_format: { type: 'json_object' } } : {}) };
  const effort = process.env.LLM_REASONING_EFFORT?.trim();
  if (effort) { if (config.apiStyle === 'responses') body.reasoning = { effort }; else body.reasoning_effort = effort; }
  const fields = { stage, moduleId, attempt }, started = Date.now();
  log('llm.request', `请求模型：${stage}${moduleId ? ' · ' + moduleId : ''}（第 ${attempt} 次）`, { ...fields, provider: config.host, model: config.model, apiStyle: config.apiStyle, maxOutputTokens: maxTokens, reasoningEffort: effort || 'provider-default' });
  const waiting = setInterval(() => log('llm.wait', '仍在等待模型响应', { ...fields, elapsedMs: Date.now() - started }), 30000);
  let response, data;
  try {
    response = await fetch(`${config.baseUrl}/${config.apiStyle === 'responses' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    data = await response.json();
  } catch (e) { log('llm.failed', '模型请求失败', { ...fields, reason: e.message, elapsedMs: Date.now() - started }, 'error'); throw e; }
  finally { clearInterval(waiting); }
  const finishReason = data.choices?.[0]?.finish_reason || data.status;
  const usage = data.usage || null;
  log('llm.response', '收到模型响应', { ...fields, status: response.status, finishReason, usage, elapsedMs: Date.now() - started });
  if (!response.ok) throw new Error(data.error?.message || data.message || `模型服务请求失败（${response.status}）。`);
  const text = config.apiStyle === 'responses' ? (data.output || []).flatMap(i => i.content || []).filter(i => i.type === 'output_text').map(i => i.text).join('') : data.choices?.[0]?.message?.content;
  return { text, usage, truncated: finishReason === 'length' || data.status === 'incomplete' };
}
