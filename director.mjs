import { checkProgram } from './video-contract.js';
import { buildMultiTurn } from './multi-turn-director.mjs';
import {normalizePlanMetadata} from './plan-metadata.mjs';

const textValue = (x, fallback = '') => typeof x === 'string' ? x.trim() || fallback : fallback;

export function normalizePlan(raw, prompt, imageCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型必须返回作品对象。');
  if (raw.status === 'clarification') return { status: 'clarification', question: textValue(raw.question, '这些图片要直接出现在视频中，还是只作为视觉参考？') };
  const metadata = normalizePlanMetadata(raw, prompt, imageCount);
  const renderCode = textValue(raw.renderCode);
  checkProgram(renderCode);
  return {version: '1.0', renderer: 'canvas-program', ...metadata, renderCode};
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
