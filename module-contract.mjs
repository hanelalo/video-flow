import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { checkProgram, MAX_MODULE_CHARS } from './video-contract.js';

export const MAX_MODULES = 48;
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const identifier = /^[a-z][a-z0-9-]{0,47}$/;
const exportName = /^[A-Za-z_$][\w$]{0,63}$/;
const fail = message => { throw new Error(message); };

export function orderModules(modules) {
  if (!Array.isArray(modules) || !modules.length || modules.length > MAX_MODULES) fail(`模块数量应为 1–${MAX_MODULES}。`);
  const byId = new Map();
  for (const m of modules) {
    if (!m || !identifier.test(m.id) || ['constructor', 'prototype'].includes(m.id) || byId.has(m.id)) fail('模块 ID 无效或重复。');
    if (typeof m.description !== 'string' || !m.description.trim()) fail(`模块 ${m.id} 缺少职责描述。`);
    if (!Array.isArray(m.dependsOn) || new Set(m.dependsOn).size !== m.dependsOn.length) fail(`模块 ${m.id} 的依赖无效。`);
    if (!Array.isArray(m.exports) || !m.exports.length || m.exports.length > 24) fail(`模块 ${m.id} 缺少导出接口。`);
    const names = new Set();
    for (const e of m.exports) {
      if (!e || !exportName.test(e.name) || ['__proto__', 'constructor', 'prototype'].includes(e.name) || names.has(e.name) || typeof e.signature !== 'string' || !e.signature.trim() || typeof e.description !== 'string' || !e.description.trim()) fail(`模块 ${m.id} 的导出接口无效。`);
      names.add(e.name);
    }
    byId.set(m.id, m);
  }
  const ordered = [], visited = new Set(), active = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (active.has(id)) fail(`模块 ${id} 存在循环依赖。`);
    const m = byId.get(id); if (!m) fail(`模块依赖 ${id} 不存在。`);
    active.add(id); for (const d of m.dependsOn) visit(d); active.delete(id); visited.add(id); ordered.push(m);
  }
  for (const id of byId.keys()) visit(id);
  return ordered;
}

export function checkDesign(design, normalizeMetadata) {
  if (design?.status === 'clarification') return normalizeMetadata(design);
  if (!design || typeof design !== 'object') fail('导演设计必须为 JSON 对象。');
  // Reuse duration, scene, ratio and asset checks without asking the model for code.
  const metadata = normalizeMetadata({ ...design, renderCode: '/* metadata validation placeholder, never rendered */\nctx.fillStyle="#000000";ctx.fillRect(0,0,width,height);' });
  // A structured visual bible carries the same information as prose; preserve it as JSON text.
  const description = value => typeof value === 'string' ? value : value && typeof value === 'object' && Object.keys(value).length ? JSON.stringify(value) : '';
  design = { ...design, visualBible: description(design.visualBible) };
  if (!design.visualBible.trim()) fail(`缺少整片视觉与运动规则。返回字段：${Object.keys(design).join(',')}`);
  if (Array.isArray(design.entities)) design.entities = design.entities.map(e => ({ ...e, appearance: description(e.appearance), motion: description(e.motion) }));
  if (Array.isArray(design.transitions)) design.transitions = design.transitions.map(tr => ({ ...tr, handoff: description(tr.handoff) }));
  if (!Array.isArray(design.entities) || !Array.isArray(design.transitions)) fail('缺少主体身份或镜头交接描述。');
  if (JSON.stringify(design).length > 96_000) fail('导演设计过长，请压缩描述并保留接口。');
  const modules = orderModules(design.modules);
  if (!modules.some(m => m.id === design.entryModuleId && m.exports.some(e => e.name === 'render'))) fail('入口模块必须导出 render()。');
  const reachable = new Set();
  const visit = id => { if (reachable.has(id)) return; reachable.add(id); modules.find(m => m.id === id).dependsOn.forEach(visit); }; visit(design.entryModuleId);
  if (reachable.size !== modules.length) fail('所有模块必须可从入口通过依赖关系访问。');
  const entities = new Set();
  for (const e of design.entities) {
    if (!e || !identifier.test(e.id) || entities.has(e.id) || typeof e.appearance !== 'string' || typeof e.motion !== 'string') fail('主体身份、造型或绝对时间运动约定无效。');
    entities.add(e.id);
  }
  for (const tr of design.transitions) {
    if (!tr || !Number.isFinite(tr.timeSec) || tr.timeSec < 0 || tr.timeSec > metadata.durationSec || typeof tr.handoff !== 'string' || !tr.handoff.trim()) fail('镜头交接时刻与状态无效。');
  }
  return { status: 'plan', question: '', title: metadata.title, durationSec: metadata.durationSec, aspectRatio: metadata.aspectRatio, loop: metadata.loop, style: metadata.style, direction: metadata.direction, assetUsage: metadata.assetUsage, scenes: metadata.scenes, visualBible: design.visualBible, entities: design.entities, transitions: design.transitions, entryModuleId: design.entryModuleId, modules: modules.map(({ id, description, dependsOn, exports }) => ({ id, description, dependsOn, exports })) };
}

export function checkModule(code, id) {
  checkProgram(code, { minLength: 10, maxLength: MAX_MODULE_CHARS });
  try { new Script(`function moduleFactory(env,deps){"use strict";\n${code}\n}`); }
  catch (error) { const e = new Error(`模块 [${id}] 无法编译：${error.message}`); e.moduleId = id; throw e; }
  return code;
}

export function affectedModules(design, targets) {
  const affected = new Set(targets);
  let changed = true;
  while (changed) { changed = false; for (const m of design.modules) if (!affected.has(m.id) && m.dependsOn.some(d => affected.has(d))) { affected.add(m.id); changed = true; } }
  return affected;
}

export function assembleModules(design, completed) {
  const ordered = orderModules(design.modules);
  const blocks = ordered.map(m => {
    const item = completed[m.id]; if (!item || item.descriptorHash !== hash(m) || item.codeHash !== hash(item.code)) fail(`模块 ${m.id} 的内容或接口已变更。`);
    checkModule(item.code, m.id);
    const key = JSON.stringify(m.id), deps = m.dependsOn.map(id => `[${JSON.stringify(id)},__vfModules[${JSON.stringify(id)}]]`).join(',');
    return `try{\n__vfModules[${key}]=(function(env,deps){"use strict";\n${item.code}\n})(__vfEnv,Object.fromEntries([${deps}]));\nconst obj=__vfModules[${key}];if(!obj||typeof obj!=="object"||typeof obj.then==="function")throw new Error("模块必须同步返回导出对象");\nfor(const name of ${JSON.stringify(m.exports.map(e => e.name))}){if(typeof obj[name]!=="function")throw new Error("缺少函数接口："+name);const fn=obj[name];obj[name]=function(...args){try{const result=fn.apply(obj,args);if(result&&typeof result.then==="function")throw new Error("模块不能异步执行");return result;}catch(e){throw __vfFailure(e,${key});}};}\n}catch(e){throw __vfFailure(e,${key});}`;
  });
  const { modules, ...bible } = design;
  const source = `const __vfEnv={ctx,t,width,height,assets,utils,design:${JSON.stringify(bible)}};\nconst __vfModules=Object.create(null);\nfunction __vfFailure(e,id){if(e&&e.moduleId)return e;const err=new Error("模块 ["+id+"]: "+String(e&&e.message||e));err.moduleId=id;return err;}\n${blocks.join('\n')}\n__vfModules[${JSON.stringify(design.entryModuleId)}].render();`;
  checkProgram(source);
  // Compile only; generated code is never executed on the Node server.
  new Script(`function render(ctx,t,width,height,assets,utils){"use strict";\n${source}\n}`);
  return source;
}
