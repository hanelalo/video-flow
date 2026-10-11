// Standalone rendering entry point included in source downloads.
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia} from '@remotion/renderer';
import {resolve} from 'node:path';
const serveUrl = await bundle({entryPoint: resolve('src/index.ts'), publicDir: resolve('public')});
const composition = await selectComposition({serveUrl, id: 'Video'});
await renderMedia({serveUrl, composition, codec: 'h264', outputLocation: resolve(process.argv[2] || 'video.mp4')});
