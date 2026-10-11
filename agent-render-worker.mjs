// Trusted entry point. Generated project code executes only in Chromium.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {bundle} from '@remotion/bundler';
import {selectComposition, renderStill, renderMedia, openBrowser} from '@remotion/renderer';

const [directory, operation, browserExecutable, startText = '0', durationText = '3'] = process.argv.slice(2);
const output = join(directory, 'output');
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
let browser;
const browserDiagnostics = [];
let currentFrame, renderStage = 'build';
const rememberDiagnostic = text => { browserDiagnostics.push(String(text).slice(-2000)); if (browserDiagnostics.length > 30) browserDiagnostics.shift(); };
// Remotion only forwards Chromium's stderr at verbose level. Keep that output
// bounded and persisted without mixing it into the structured progress stream.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
  rememberDiagnostic(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
  return originalStderrWrite(chunk, encoding, callback);
};
try {
  await mkdir(output, {recursive: true});
  await promisify(execFile)(process.execPath, [join(directory, 'node_modules/typescript/bin/tsc'), '--project', join(directory, 'tsconfig.json'), '--pretty', 'false'], {cwd: directory, timeout: 120_000, maxBuffer: 1_000_000});
  const spec = JSON.parse(await readFile(join(directory, '.video-flow/spec.json'), 'utf8'));
  const serveUrl = await bundle({entryPoint: join(directory, 'src/index.ts'), rootDir: directory, publicDir: join(directory, 'public'), outDir: join(output, 'bundle'), enableCaching: false});
  // Untrusted artwork cannot call other localhost projects or external services.
  const indexPath = join(serveUrl, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  await writeFile(indexPath, html.replace('<head>', '<head>' + csp));
  if (operation === 'check') { emit({type: 'result', ok: true, bundle: serveUrl}); }
  else {
    const layout = [], logs = [];
    const onBrowserLog = event => { if (event.text.startsWith('[vf-layout]')) { try { layout.push(JSON.parse(event.text.slice(11))); } catch {} } else if (event.type === 'error') logs.push(event.text.slice(0, 1000)); };
    renderStage = 'browser';
    browser = await openBrowser('chrome', {browserExecutable, logLevel: 'verbose', chromiumOptions: {gl: 'swangle'}});
    renderStage = 'composition';
    const composition = await selectComposition({serveUrl, id: 'Video', puppeteerInstance: browser, logLevel: 'error', onBrowserLog});
    if (composition.width !== spec.width || composition.height !== spec.height || composition.fps !== spec.fps || composition.durationInFrames !== spec.durationInFrames) throw new Error('渲染规格与宿主锁定的时间轴不一致。');
    if (operation === 'frames') {
      const frames = [...new Set([0, spec.durationInFrames - 1, ...spec.sampleFrames])].sort((a, b) => a - b);
      const files = [];
      const hashes = new Map();
      for (const frame of frames) {
        renderStage = 'screenshot'; currentFrame = frame;
        const path = join(output, `frame-${String(frame).padStart(7, '0')}.png`);
        await renderStill({serveUrl, composition, frame, output: path, puppeteerInstance: browser, logLevel: 'error', onBrowserLog});
        hashes.set(frame, createHash('sha256').update(await readFile(path)).digest('hex'));
        files.push({frame, path}); emit({type: 'progress', phase: 'frames', completed: files.length, total: frames.length});
      }
      if (new Set(hashes.values()).size < 2) logs.push('所有代表帧完全相同，需要实现随时间变化的画面。');
      const repeatFrame = frames[Math.floor(frames.length / 2)], repeatPath = join(output, 'repeat-frame.png');
      currentFrame = repeatFrame;
      await renderStill({serveUrl, composition, frame: repeatFrame, output: repeatPath, puppeteerInstance: browser, logLevel: 'error', onBrowserLog});
      const repeatHash = createHash('sha256').update(await readFile(repeatPath)).digest('hex');
      if (hashes.get(repeatFrame) !== repeatHash) logs.push(`跳转后第 ${repeatFrame} 帧不一致，请用绝对帧数和固定随机种子生成动画。`);
      emit({type: 'result', ok: !layout.length && !logs.length, files, layout, errors: logs, motion: new Set(hashes.values()).size >= 2, deterministic: hashes.get(repeatFrame) === repeatHash});
    } else if (operation === 'preview' || operation === 'export') {
      const start = Math.max(0, Math.floor(Number(startText) * spec.fps));
      const length = Math.min(8, Math.max(.1, Number(durationText)));
      const frameRange = operation === 'preview' ? [Math.min(start, spec.durationInFrames - 1), Math.min(spec.durationInFrames - 1, start + Math.ceil(length * spec.fps) - 1)] : undefined;
      const path = join(output, operation === 'preview' ? 'preview.mp4' : 'video.mp4');
      renderStage = 'export'; currentFrame = undefined;
      let previous = -1;
      const concurrency = Number(process.env.VIDEO_RENDER_CONCURRENCY || 1);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('VIDEO_RENDER_CONCURRENCY 必须为 1–4。');
      await renderMedia({serveUrl, composition, codec: 'h264', outputLocation: path, frameRange, puppeteerInstance: browser, logLevel: 'error', concurrency, onBrowserLog, onProgress: p => { const percent = Math.floor(p.progress * 100); if (percent >= previous + 5) { previous = percent; emit({type: 'progress', phase: 'export', percent}); } }});
      emit({type: 'result', ok: !logs.length, path, layout: layout.slice(0, 100), errors: logs});
    } else throw new Error('未知渲染操作。');
  }
} catch (error) {
  const screenshotFailure = /Unable to capture screenshot|Could not take a screenshot because Google Chrome ran out of memory or disk space/.test(error.message);
  const hostEnvironment = screenshotFailure || /bootstrap_check_in[^\n]*Permission denied|sandbox-exec:/.test(error.message);
  const report = {operation, stage: renderStage, frame: currentFrame, error: [error.message, error.stdout, error.stderr].filter(Boolean).join('\n').slice(0, 12000), hostEnvironment, browserDiagnostics};
  await writeFile(join(output, `render-error-${operation}.json`), JSON.stringify(report, null, 2)).catch(() => {});
  emit({type: 'result', ok: false, ...report});
  process.exitCode = 1;
} finally { await browser?.close({silent: true}).catch(() => {}); }
