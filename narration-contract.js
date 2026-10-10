import { MAX_DURATION_SEC, MAX_SCENES } from './video-contract.js';
export function normalizeStoryboard(raw) {
  if (!raw || !Array.isArray(raw.scenes) || !raw.scenes.length || raw.scenes.length > MAX_SCENES) throw new Error('解说时间轴需要 1–120 个片段。');
  const ids = new Set(); let time = 0;
  const str = (v, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
  const scenes = raw.scenes.map((s, i) => {
    const id = str(s.id, 48) || `scene-${i + 1}`;
    if (ids.has(id)) throw new Error('解说片段 ID 重复。'); ids.add(id);
    const durationSec = Number(s.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SEC) throw new Error('解说片段时长无效。');
    const startSec = time; time += durationSec;
    const cues = (s.cues || []).map(c => {
      if (!Number.isFinite(c.startSec) || !Number.isFinite(c.endSec) || c.startSec < 0 || c.endSec <= c.startSec || c.endSec > durationSec + .001 || !str(c.text, 200).trim()) throw new Error('字幕时间或内容无效。');
      return { startSec: c.startSec, endSec: c.endSec, text: str(c.text, 200) };
    });
    if (cues.length > 100) throw new Error('每段最多100条字幕。');
    return { id, durationSec, startSec, endSec: time, headline: str(s.headline, 160), body: str(s.body), narration: str(s.narration), visual: str(s.visual), chapter: str(s.chapter, 160), source: str(s.source, 500), cues };
  });
  if (time < 3 || time > MAX_DURATION_SEC) throw new Error('解说总时长应为 3–1800 秒。');
  return { title: str(raw.title, 160), durationSec: time, researchedAt: str(raw.researchedAt, 32), scenes };
}
export function drawCaptions(ctx, storyboard, t, width, height) {
  if (!storyboard) return;
  const scene = storyboard.scenes.find(s => t >= s.startSec && t < s.endSec);
  const cue = scene?.cues.find(c => t - scene.startSec >= c.startSec && t - scene.startSec < c.endSec);
  if (!cue) return;
  ctx.save(); ctx.resetTransform(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const size = Math.round(height * .035); ctx.font = `500 ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = []; let line = '';
  for (const ch of cue.text) { if (ctx.measureText(line + ch).width > width * .86 && line) { lines.push(line); line = ''; } line += ch; } if (line) lines.push(line);
  const lineHeight = size * 1.5, boxHeight = lines.length * lineHeight + size * .7, bottom = height * .975;
  const boxWidth = Math.min(width * .94, Math.max(...lines.map(l => ctx.measureText(l).width)) + size * 2);
  ctx.fillStyle = 'rgba(5,10,20,.88)'; ctx.beginPath(); ctx.roundRect((width - boxWidth) / 2, bottom - boxHeight, boxWidth, boxHeight, size * .3); ctx.fill();
  ctx.fillStyle = '#f3f6fc'; lines.forEach((l,i) => ctx.fillText(l, width / 2, bottom - boxHeight + size * .35 + lineHeight * (i + .5)));
  ctx.restore();
}
