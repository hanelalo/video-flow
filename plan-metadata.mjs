import {dimensions, MAX_DURATION_SEC, MAX_SCENES} from './video-contract.js';

const textValue = (value, fallback = '') => typeof value === 'string' ? value.trim() || fallback : fallback;

// Shared video metadata. Drawing code is validated by each renderer separately.
export function normalizePlanMetadata(raw, prompt, imageCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('作品规格必须是一个对象。');
  const durationSec = Number(raw.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 3 || durationSec > MAX_DURATION_SEC) throw new Error(`视频时长须为 3–${MAX_DURATION_SEC} 秒。`);
  const aspectRatio = textValue(raw.aspectRatio, '9:16'); dimensions(aspectRatio);
  if (!Array.isArray(raw.scenes) || raw.scenes.length < 1 || raw.scenes.length > MAX_SCENES) throw new Error(`请提供 1–${MAX_SCENES} 段时间说明。`);
  const ids = new Set();
  const scenes = raw.scenes.map((scene, index) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error(`第 ${index + 1} 镜规格无效。`);
    let id = textValue(scene.id, `shot-${index + 1}`);
    if (ids.has(id)) id = `shot-${index + 1}`;
    while (ids.has(id)) id += '-x'; ids.add(id);
    const durationSec = Number(scene.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error(`第 ${index + 1} 镜时长无效。`);
    return {id, durationSec, headline: textValue(scene.headline, `镜头 ${index + 1}`), body: textValue(scene.body)};
  });
  if (Math.abs(scenes.reduce((sum, scene) => sum + scene.durationSec, 0) - durationSec) > .05) throw new Error('分镜时长与程序总时长不一致，请同时修正元数据和动画时间。');
  const assetUsage = Array.isArray(raw.assetUsage) ? raw.assetUsage : [];
  if (assetUsage.some(asset => !asset || !Number.isInteger(asset.index) || asset.index < 0 || asset.index >= imageCount || !['content', 'reference', 'unused'].includes(asset.role))) throw new Error('图片用途引用了不存在的附件。');
  return {status: 'plan', question: '', title: textValue(raw.title, prompt.slice(0, 35)), durationSec, aspectRatio, loop: raw.loop === true, style: textValue(raw.style), direction: textValue(raw.direction), assetUsage, scenes};
}
