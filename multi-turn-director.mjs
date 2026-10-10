import { checkDesign, checkModule, orderModules, affectedModules, assembleModules, hash, MAX_MODULES } from './module-contract.mjs';
import { requestModel, parseObject, outputCode, TruncatedOutput } from './model-client.mjs';
import { MAX_MODULE_CHARS } from './video-contract.js';

const art = `你是独立短片导演和 Canvas 动画程序员。根据题材原创造型、材质、构图、运镜和动作，不使用固定组件库或默认演示页。所有缺省细节由你决定，只有图片用途确实无法判断时才询问。有解说时间轴时，系统会叠加字幕，请保留底部15%安全区；其他画面与转场由你编程实现。作品可以是长镜头，也可以有连贯的多镜头。具体主体须有可识别结构与动作，避免退化成几个通用几何图标。`;
const runtime = `运行约定：每个模块是同步 JavaScript 工厂函数的函数体，参数 env 与 deps；不要输出工厂包装或 import/export。env 包含 ctx,t,width,height,assets,utils,design。ctx 是 OffscreenCanvas 原生 2D 上下文；t 是整片绝对秒数；assets 为 ImageBitmap 数组；utils 有 duration/clamp/lerp/smooth/easeOut/random(seed)。env.design 是导演设计（视觉规则、主体和交接）。deps[模块ID] 是依赖模块返回的对象。
模块结尾必须 return 一个对象，其所有约定导出项必须是同步函数。入口模块导出 render()，负责调用依赖并完整绘制当前帧；其他模块只按职责绘图或计算，初始化时不擅自清屏。每一帧都会重新创建模块；通过 env/deps 的闭包共享本帧对象。任何时间都须直接得到正确画面，不依赖前一帧、真实时钟或外部状态。共享主体轨迹用同一函数和绝对 t，模块可以跨镜头运行。保留交接窗口的主体位置、比例、方向、相机及动势。
可用所有常见 Canvas 2D 方法、Path2D、OffscreenCanvas、数学、局部对象、原创路径、渐变、纹理、合成和透视。字体使用系统字体。半径和线宽非负，限定循环，整片每帧不超过约4000次绘图。禁止 DOM、网络、文件、全局对象、计时器、动态执行、异步函数或 Promise。随机数用 utils.random(固定种子)。返回完整实现，不能写占位或省略。`;

const designInstructions = `${art}
本轮只输出整片设计 JSON，不生成代码。必需字段：status(plan/clarification),question,title,durationSec(3–1800),aspectRatio(例如16:9),loop,style,direction,assetUsage([{index,role:content/reference/unused}]),scenes([{id,durationSec,headline,body}]),visualBible,entities([{id,appearance,motion}]),transitions([{timeSec,handoff}]),entryModuleId,modules([{id,description,dependsOn,exports:[{name,signature,description}]}])。
scenes 合计等于总时长，仅为用户时间说明。visualBible 是非空字符串，描述整片坐标约定、统一材质、字体、安全区、运镜和连续性。entities 用稳定ID和具体造型、参数、绝对时间轨迹约定主体身份；transitions 用具体时刻与位置、尺度、朝向、相机描述交接。没有主体或转场可用空数组。
模块由本片的复杂度决定，通常3–8个，最多12个起始模块；每个预计实现应小于12000字符。按绘图或计算职责拆分，共用函数先生成，允许模块跨镜头或同时画多图层。模块必须组成无环依赖图，所有模块从入口可访问。ID用小写字母开头、字母数字连字符。只有入口需要导出render()；所有导出是函数，signature明确参数和返回结构及坐标约定，不能只写模糊函数名。依赖者必须严格调用这些接口。
${runtime}
clarification 时只需status和question。不要在JSON中附renderCode或代码字符串。`;

export async function buildMultiTurn(input, config, log, persistence, normalizePlan) {
  const cp = persistence?.checkpoint || {};
  cp.completed ||= {}; cp.usage ||= []; cp.splitDepth ||= {};
  const images = input.images || [];
  const storyboard = input.storyboard || input.repair?.plan?.storyboard || input.repair?.plan?.moduleDesign?.storyboard;
  const normalize = raw => normalizePlan(storyboard && raw.status !== 'clarification' ? { ...raw, durationSec: storyboard.durationSec, scenes: storyboard.scenes } : raw, input.prompt, images.length);
  const designCheck = raw => { const d = checkDesign(raw, normalize); if (storyboard && d.status === 'plan') d.storyboard = storyboard; return d; };
  const save = async (stage, moduleId) => {
    cp.stage = stage;
    await persistence?.saveCheckpoint(cp, { phase: stage, completed: cp.design ? cp.design.modules.filter(m => cp.completed[m.id]).length : 0, total: cp.design?.modules.length || 0, moduleId });
  };
  async function ask(stage, system, request, validate, { json = true, moduleId, attempts = 3, splitOnLimit = false, attachments = [] } = {}) {
    let feedback = '';
    if (cp.pendingResponse?.stage === stage && cp.pendingResponse.moduleId === moduleId && !cp.pendingResponse.truncated) {
      try { const recovered = validate(json ? parseObject(cp.pendingResponse.text) : outputCode(cp.pendingResponse.text)); delete cp.pendingResponse; await save(stage, moduleId); return recovered; }
      catch (e) { feedback = e.message; }
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await save(stage, moduleId);
      const response = await requestModel(config, { system, request: request + (feedback ? `\n本部分上次失败：${feedback}\n请修正后重新完整输出本部分。` : ''), json, images: attachments, stage, moduleId, attempt }, log);
      cp.pendingResponse = { stage, moduleId, text: response.text, truncated: response.truncated };
      cp.usage.push({ stage, moduleId, attempt, usage: response.usage, truncated: response.truncated });
      await save(stage, moduleId);
      try {
        if (response.truncated) throw new TruncatedOutput();
        const value = validate(json ? parseObject(response.text) : outputCode(response.text)); delete cp.pendingResponse; return value;
      } catch (e) {
        log('step.retry', `当前部分未通过检查：${stage}${moduleId ? ' · ' + moduleId : ''}`, { stage, moduleId, attempt, reason: e.message }, 'warn');
        if (splitOnLimit && (e.code === 'OUTPUT_TRUNCATED' || /超过 .*字符/.test(e.message))) { e.splitModule = true; throw e; }
        if (attempt === attempts) throw e;
        feedback = e.message;
      }
    }
  }

  if (!cp.design) {
    const old = input.repair?.plan;
    let reuse = false, targets = [];
    if (old?.moduleDesign && Array.isArray(old.modules)) {
      const previous = designCheck(old.moduleDesign);
      const pointed = input.repair.moduleId || String(input.repair.diagnostics).match(/模块 \[([a-z][a-z0-9-]*)\]/)?.[1];
      if (pointed && previous.modules.some(m => m.id === pointed)) { reuse = true; targets = [pointed]; }
      else {
        const selection = await ask('repair-selection', `${art}\n根据用户反馈决定是否需要重做整片导演设计。输出JSON {rebuildDesign:boolean,affectedModuleIds:[模块ID],reason:string}。时长、比例、接口、叙事或主体身份变化通常需要重设计；局部动作、造型、文字、绘制错误应选择相关模块。`, `现有设计：${JSON.stringify(previous)}\n反馈：${String(input.repair.diagnostics).slice(0, 5000)}`, raw => {
          if (typeof raw.rebuildDesign !== 'boolean' || !Array.isArray(raw.affectedModuleIds) || raw.affectedModuleIds.some(id => !previous.modules.some(m => m.id === id)) || (!raw.rebuildDesign && !raw.affectedModuleIds.length)) throw new Error('修复选择必须给出有效模块或明确重做设计。');
          return raw;
        });
        reuse = !selection.rebuildDesign; targets = selection.affectedModuleIds;
      }
      if (reuse) {
        const affected = affectedModules(previous, targets);
        cp.design = previous; cp.repairTargets = [...affected];
        for (const module of old.modules) {
          const spec = previous.modules.find(m => m.id === module.id);
          if (spec && !affected.has(module.id)) {
            checkModule(module.code, module.id);
            cp.completed[module.id] = { code: module.code, codeHash: hash(module.code), descriptorHash: hash(spec) };
          }
        }
        log('repair.selected', '已定位受影响模块，共用其余已完成模块', { modules: [...affected], reused: Object.keys(cp.completed).length });
      }
    }
    if (!reuse) {
      log('design.start', '开始整片导演设计与模块规划');
      const previous = old ? JSON.stringify(old.moduleDesign || { title: old.title, durationSec: old.durationSec, aspectRatio: old.aspectRatio, style: old.style, direction: old.direction, scenes: old.scenes, renderCode: old.renderCode }) : '';
      const design = await ask('design', designInstructions, `用户想法：${input.prompt}\n${storyboard ? `解说时间轴（由系统锁定总时长与场景顺序；不得压缩、合并或改变章节，代码直接读取env.design.storyboard.scenes，每场景有startSec/endSec/headline/body/visual/chapter/source；字幕由系统绘制）：${JSON.stringify(storyboard)}` : ''}\n图片用途补充：${input.clarificationAnswer || ''}\n${old ? `保留原作品中未被反馈要求改变的方向。旧作品：${previous}\n反馈：${String(input.repair.diagnostics).slice(0, 5000)}` : ''}`, raw => {
        const d = designCheck(raw); if (d.status === 'plan' && d.modules.length > 12) throw new Error('初始设计最多12个模块，请按职责组织。'); return d;
      }, { attachments: images });
      if (design.status === 'clarification') return { mode: 'ai', plan: design, usage: cp.usage };
      cp.design = design; cp.completed = {};
      log('design.complete', '整片设计已保存', { modules: design.modules.length, scenes: design.scenes.length, durationSec: design.durationSec });
    }
    await save('modules');
  } else {
    cp.design = designCheck(cp.design);
    log('job.restored', '从已保存的创作步骤继续', { completed: Object.keys(cp.completed).length, total: cp.design.modules.length });
  }

  async function split(spec) {
    const depth = cp.splitDepth[spec.id] || 0;
    if (depth >= 3 || cp.design.modules.length >= MAX_MODULES - 1) throw new Error(`模块 ${spec.id} 多次拆分仍未完成；已保存进度，可调整输出预算后继续。`);
    log('module.split', '模块输出超限，拆成更小职责并保留原接口', { moduleId: spec.id, depth });
    cp.pendingSplit = spec.id; await save('split', spec.id);
    const existingIds = new Set(cp.design.modules.map(m => m.id));
    const next = await ask('split', `${art}\n输出小份JSON {children:[模块描述],parent:模块描述}，描述格式为{id,description,dependsOn,exports:[{name,signature,description}]}。将指定模块拆成2–4个更小模块和一个很短的父模块。父模块保留原ID及原导出接口，由它调用子模块实现原职责；不能改变调用者接口。子模块只依赖原依赖或其他子模块，不能依赖父模块。不得输出代码。`, `整片设计：${JSON.stringify(cp.design)}\n需要拆分：${JSON.stringify(spec)}\n已有ID：${cp.design.modules.map(m => m.id).join(',')}`, raw => {
      if (!Array.isArray(raw.children) || raw.children.length < 2 || raw.children.length > 4 || !raw.parent) throw new Error('拆分需要2–4个子模块和父模块。');
      const ids = new Set(raw.children.map(m => m.id));
      if (ids.size !== raw.children.length || raw.children.some(m => cp.design.modules.some(o => o.id === m.id))) throw new Error('子模块ID必须唯一且不能覆盖现有模块。');
      if (raw.children.some(m => !Array.isArray(m.dependsOn) || m.dependsOn.some(d => !spec.dependsOn.includes(d) && !ids.has(d)))) throw new Error('子模块只能依赖原依赖和其他子模块。');
      const parent = { ...raw.parent, id: spec.id, exports: spec.exports, dependsOn: [...new Set([...spec.dependsOn, ...ids])] };
      return designCheck({ ...cp.design, modules: [...cp.design.modules.filter(m => m.id !== spec.id), ...raw.children, parent] });
    });
    const affected = affectedModules(cp.design, [spec.id]); for (const id of affected) delete cp.completed[id];
    cp.design = next; cp.splitDepth[spec.id] = depth + 1;
    for (const m of next.modules) if (!existingIds.has(m.id)) cp.splitDepth[m.id] = depth + 1;
    delete cp.pendingSplit;
    await save('modules');
  }

  if (cp.pendingSplit) {
    const spec = cp.design.modules.find(m => m.id === cp.pendingSplit);
    if (!spec) throw new Error('待拆分模块已不存在，任务记录不一致。');
    await split(spec);
  }
  for (;;) {
    const specs = orderModules(cp.design.modules);
    // Validate persisted hashes and invalidate dependants of any incomplete module.
    const invalid = specs.filter(m => !cp.completed[m.id] || typeof cp.completed[m.id].code !== 'string' || cp.completed[m.id].descriptorHash !== hash(m) || cp.completed[m.id].codeHash !== hash(cp.completed[m.id].code)).map(m => m.id);
    const affected = affectedModules(cp.design, invalid); for (const id of affected) delete cp.completed[id];
    const spec = specs.find(m => !cp.completed[m.id]); if (!spec) break;
    const index = specs.indexOf(spec) + 1;
    log('module.start', `生成模块 ${index}/${specs.length}：${spec.description}`, { moduleId: spec.id, completed: Object.keys(cp.completed).length, total: specs.length });
    const direct = spec.dependsOn.map(id => ({ ...specs.find(m => m.id === id), code: cp.completed[id]?.code }));
    // Interfaces are complete even when dependency source is too large to resend.
    const dependencies = JSON.stringify(direct).length > 160000 ? direct.map(({ code, ...contract }) => contract) : direct;
    const previousCode = input.repair?.plan?.modules?.find(m => m.id === spec.id)?.code;
    try {
      const code = await ask('module', `${art}\n${runtime}\n本轮只输出指定模块的纯JavaScript函数体，不输出JSON、Markdown、解释或其他模块。代码目标小于12000字符，硬上限${MAX_MODULE_CHARS}字符。实现完整导出接口，返回对象中的函数通过闭包访问env和deps。`, `整片设计：${JSON.stringify(cp.design)}\n当前模块：${JSON.stringify(spec)}\n可用依赖：${JSON.stringify(dependencies)}\n${input.repair ? `创作反馈或执行诊断：${String(input.repair.diagnostics).slice(0, 5000)}\n${previousCode ? `本模块旧实现：${previousCode}` : ''}` : ''}`, code => checkModule(code, spec.id), { json: false, moduleId: spec.id, splitOnLimit: true, attachments: images });
      cp.completed[spec.id] = { code, codeHash: hash(code), descriptorHash: hash(spec) };
      await save('modules', spec.id);
      log('module.complete', `模块 ${index}/${specs.length} 已编译并保存`, { moduleId: spec.id, codeChars: code.length, completed: Object.keys(cp.completed).length, total: specs.length });
    } catch (e) { if (!e.splitModule) throw e; await split(spec); }
  }
  await save('assemble'); log('assemble.start', '服务端组装整片程序与完整 JSON');
  const renderCode = assembleModules(cp.design, cp.completed);
  const plan = { ...normalize({ ...cp.design, renderCode }), version: '2.0', storyboard, moduleDesign: cp.design, modules: orderModules(cp.design.modules).map(m => ({ ...m, ...cp.completed[m.id] })) };
  // JSON serialization belongs to the application, not a final model call.
  JSON.stringify(plan);
  await save('complete');
  log('assemble.complete', '模块已合成，等待隔离画布验证', { modules: plan.modules.length, codeChars: renderCode.length, calls: cp.usage.length });
  return { mode: 'ai', plan, usage: { calls: cp.usage } };
}
