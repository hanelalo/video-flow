export function dimensions(ratio, shortSide = 720) {
  if (![720, 1080].includes(shortSide)) throw new Error('画面短边支持720或1080像素。');
  const match = String(ratio).match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) throw new Error('画面比例应为两个正整数，例如 16:9、9:16 或 1:1。');
  const a = Number(match[1]), b = Number(match[2]), value = a / b;
  if (!a || !b || value < .4 || value > 2.5) throw new Error('画面比例超出当前导出的范围（0.4–2.5）。');
  const even = n => Math.round(n / 2) * 2;
  return value >= 1 ? { width: even(shortSide * value), height: shortSide } : { width: shortSide, height: even(shortSide / value) };
}

export const MAX_DURATION_SEC = 1800;
export const MAX_SCENES = 120;
export const MAX_PROGRAM_CHARS = 768_000;
export const MAX_MODULE_CHARS = 48_000;

export function checkProgram(source, { minLength = 80, maxLength = MAX_PROGRAM_CHARS } = {}) {
  if (typeof source !== 'string' || source.trim().length < minLength) throw new Error('AI 没有返回完整的画面程序。');
  if (source.length > maxLength) throw new Error(`画面程序超过 ${maxLength} 字符的运行上限。`);
  // Generated programs run only inside an isolated, network-disabled worker.
  // Also reject capabilities that are unrelated to drawing before starting it.
  const code = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const blocked = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|import|export|eval|Function|globalThis|self|window|document|navigator|postMessage|Worker|SharedWorker|WebAssembly|indexedDB|localStorage|sessionStorage|setInterval|setTimeout|Date)\b/;
  const found = code.match(blocked);
  if (found) throw new Error(`画面程序使用了不允许的能力：${found[0]}。请只使用绘图、数学与已提供的素材。`);
  if (/while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;/.test(code)) throw new Error('画面程序含有无限循环。');
}
