import { dimensions, checkProgram, MAX_DURATION_SEC, MAX_SCENES } from './video-contract.js';
import { buildMultiTurn } from './multi-turn-director.mjs';

const textValue = (x, fallback = '') => typeof x === 'string' ? x.trim() || fallback : fallback;

export function normalizePlan(raw, prompt, imageCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型必须返回作品对象。');
  if (raw.status === 'clarification') return { status: 'clarification', question: textValue(raw.question, '这些图片要直接出现在视频中，还是只作为视觉参考？') };
  const durationSec = Number(raw.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 3 || durationSec > MAX_DURATION_SEC) throw new Error(`模型返回的视频时长超出 3–${MAX_DURATION_SEC} 秒。`);
  const aspectRatio = textValue(raw.aspectRatio, '9:16'); dimensions(aspectRatio);
  const renderCode = textValue(raw.renderCode);
  checkProgram(renderCode);
  if (!Array.isArray(raw.scenes) || raw.scenes.length < 1 || raw.scenes.length > MAX_SCENES) throw new Error(`请提供 1–${MAX_SCENES} 段时间说明。`);
  const ids = new Set();
  const scenes = raw.scenes.map((s, i) => {
    let id = textValue(s.id, `shot-${i + 1}`); if (ids.has(id)) id = `shot-${i + 1}`; while (ids.has(id)) id += '-x'; ids.add(id);
    const d = Number(s.durationSec); if (!Number.isFinite(d) || d <= 0) throw new Error(`第 ${i + 1} 镜时长无效。`);
    return { id, durationSec: d, headline: textValue(s.headline, `镜头 ${i + 1}`), body: textValue(s.body) };
  });
  if (Math.abs(scenes.reduce((sum, s) => sum + s.durationSec, 0) - durationSec) > .05) throw new Error('分镜时长与程序总时长不一致，请同时修正元数据和动画时间。');
  const assetUsage = Array.isArray(raw.assetUsage) ? raw.assetUsage : [];
  if (assetUsage.some(a => !Number.isInteger(a.index) || a.index < 0 || a.index >= imageCount || !['content', 'reference', 'unused'].includes(a.role))) throw new Error('图片用途引用了不存在的附件。');
  return { version: '1.0', renderer: 'canvas-program', status: 'plan', question: '', title: textValue(raw.title, prompt.slice(0, 35)), durationSec, aspectRatio, loop: raw.loop === true, style: textValue(raw.style), direction: textValue(raw.direction), assetUsage, scenes, renderCode };
}

function demoPlan(prompt, images, answer) {
  if (images.length && !answer && !/图片.{0,12}(素材|参考|展示|使用|风格)/u.test(prompt)) return { status: 'clarification', question: '你希望图片出现在画面中，还是仅作为风格参考？' };
  return normalizePlan({ title: '演示 · 流体光场', durationSec: 8, aspectRatio: '16:9', loop: true, style: '程序化流体线条', direction: '演示运行环境，正式创作需要模型 API。', assetUsage: [], scenes: [{ id: 'demo', durationSec: 8, headline: '演示运行环境', body: '这个固定演示用于检查执行、预览与导出。' }], renderCode: `const w=width,h=height; ctx.fillStyle='#080918';ctx.fillRect(0,0,w,h); const phase=t/8*Math.PI*2; for(let i=0;i<100;i++){ctx.beginPath();ctx.strokeStyle='hsla('+ (180+i*1.5)+',85%,65%,0.5)';ctx.lineWidth=1.8;for(let j=0;j<=80;j++){const x=j/80*w,y=h*.5+Math.sin(j*.07+phase+i*.05)*h*.22+Math.sin(j*.16-phase+i*.04)*h*.12; j?ctx.lineTo(x,y+i*.7-35):ctx.moveTo(x,y+i*.7-35);}ctx.stroke();}` }, prompt, images.length);
}

export async function makePlan(input, config, log = () => {}, persistence) {
  if (!config.apiKey) { log('llm.demo', '未配置密钥，使用演示作品'); return { mode: 'demo', plan: demoPlan(input.prompt, input.images || [], input.clarificationAnswer || '') }; }
  if (!config.model) throw new Error('请在 .env 中配置 LLM_MODEL。');
  if (!['chat-completions', 'responses'].includes(config.apiStyle)) throw new Error('LLM_API_STYLE 只能是 chat-completions 或 responses。');
  return buildMultiTurn(input, config, log, persistence, normalizePlan);
}
