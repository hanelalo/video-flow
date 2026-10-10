import { checkProgram } from './video-contract.js';

export class ProgramRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.pending = new Map(); this.serial = 0;
    this.onMessage = event => {
      const m = event.data;
      if (!this.frame || event.source !== this.frame.contentWindow || m?.token !== this.token) return;
      const pending = this.pending.get(m.id);
      if (!pending) { m.bitmap?.close(); return; }
      clearTimeout(pending.timer); this.pending.delete(m.id);
      if (m.type === 'error') { const error = new Error([m.message, m.stack].filter(Boolean).join('\n')); error.moduleId = m.moduleId; pending.reject(error); }
      else pending.resolve(m);
    };
    addEventListener('message', this.onMessage);
  }
  async load(plan, images) {
    checkProgram(plan.renderCode); this.disposeFrame();
    this.token = crypto.randomUUID(); this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts'); this.frame.hidden = true;
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.src = '/sandbox-frame.html';
    const loaded = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('隔离运行环境加载超时。')), 10000); this.frame.onload = () => { clearTimeout(timer); resolve(); }; this.frame.onerror = () => { clearTimeout(timer); reject(new Error('隔离运行环境加载失败。')); }; });
    document.body.append(this.frame); await loaded;
    return this.request({ type: 'init', code: plan.renderCode, duration: plan.durationSec, width: this.canvas.width, height: this.canvas.height, images: images.map(image => image.dataUrl) }, 12000);
  }
  request(message, timeoutMs = 5000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.frame?.contentWindow.postMessage({ type: 'dispose', token: this.token }, '*'); reject(new Error('隔离画面程序没有及时响应，已停止。')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.frame.contentWindow.postMessage({ ...message, id, token: this.token }, '*');
    });
  }
  async render(time) {
    const { bitmap, renderMs } = await this.request({ type: 'render', time });
    this.ctx.resetTransform(); this.ctx.globalAlpha = 1; this.ctx.globalCompositeOperation = 'copy'; this.ctx.drawImage(bitmap, 0, 0); this.ctx.globalCompositeOperation = 'source-over'; bitmap.close();
    return renderMs;
  }
  disposeFrame() {
    if (this.frame) { this.frame.contentWindow.postMessage({ type: 'dispose', token: this.token }, '*'); this.frame.remove(); this.frame = null; }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('作品已切换。')); }
    this.pending.clear();
  }
  destroy() { this.disposeFrame(); removeEventListener('message', this.onMessage); }
}
