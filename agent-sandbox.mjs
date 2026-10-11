import {spawn, execFileSync} from 'node:child_process';
import {realpath, mkdir, writeFile} from 'node:fs/promises';
import {dirname, join, basename} from 'node:path';
import {homedir} from 'node:os';
import {assertNodeRuntime} from './node-runtime.mjs';

const children = new Set(), stopping = new WeakMap();
function killChildren() { for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
process.once('exit', killChildren);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { killChildren(); process.exit(signal === 'SIGTERM' ? 143 : 130); });

export async function locatePi() {
  assertNodeRuntime();
  const executable = process.env.PI_BIN || execFileSync('/usr/bin/which', ['pi'], {encoding: 'utf8'}).trim();
  const path = await realpath(executable);
  let installation = dirname(path);
  if (path.endsWith('/agent/bin/pi')) installation = join(dirname(dirname(path)), 'install');
  return {executable: path, installation};
}
const quote = value => JSON.stringify(value);
export function sandboxProfile({readPaths, writePaths, protectedPaths = [], networkPort, renderer = false, temporaryPath}) {
  // No allow-default fallback: unsupported hosts must provide an explicit adapter.
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal process-info* (target same-sandbox))
(allow mach-priv-task-port (target same-sandbox))
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.tcsm_enable"))
(allow mach-lookup (global-name "com.apple.FontObjectsServer") (global-name "com.apple.fonts") (global-name "com.apple.logd") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership"))
(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))
(allow file-read-metadata)
(allow file-read* file-map-executable (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Fonts") (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/opt/homebrew") (subpath "/dev")
  ${readPaths.map(p => `(subpath ${quote(p)})`).join(' ')})
(allow file-write* ${writePaths.map(p => `(subpath ${quote(p)})`).join(' ')} (literal "/dev/null"))
${protectedPaths.length ? `(deny file-write* ${protectedPaths.map(p => `(subpath ${quote(p)})`).join(' ')})` : ''}
${renderer ? `(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
(allow mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
(allow mach-lookup (global-name "com.apple.CARenderServer"))
(allow iokit-open (iokit-user-client-class "IOSurfaceRootUserClient"))
(allow network-bind (local ip "*:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow system-socket (socket-domain AF_UNIX))
(allow network-bind (local unix-socket (subpath ${quote(temporaryPath)})))
(allow network-outbound (remote unix-socket (subpath ${quote(temporaryPath)})))` : `(allow network-outbound (remote ip "localhost:${networkPort}"))`}
`;
}
export async function prepareSandbox({root, directory, pi, brokerPort, renderer = false, browserPath}) {
  if (process.platform !== 'darwin') throw new Error('当前隔离执行适配器需要 macOS sandbox-exec；其他系统需配置容器适配器，不能直接降级为裸进程。');
  await mkdir(join(directory, 'tmp'), {recursive: true});
  await mkdir(join(directory, 'home'), {recursive: true});
  const dependencies = await realpath(join(root, 'node_modules'));
  const profile = sandboxProfile({
    readPaths: [directory, dependencies, join(root, 'agent-render-worker.mjs'), join(root, 'package.json'), ...(browserPath ? [dirname(await realpath(browserPath))] : []), ...(pi ? [pi.executable, pi.installation, join(homedir(), '.local/share/pi-node')] : [])],
    writePaths: renderer ? [join(directory, 'output'), join(directory, 'tmp'), join(directory, 'home')] : [join(directory, 'src'), join(directory, 'public'), join(directory, 'project.json'), join(directory, 'REVIEW.md'), join(directory, 'question.json'), join(directory, 'control'), join(directory, 'tmp'), join(directory, 'home')],
    protectedPaths: [join(directory, 'src/Root.tsx'), join(directory, 'src/index.ts')],
    networkPort: brokerPort, renderer, temporaryPath: join(directory, 'tmp')
  });
  // Keep policy files outside every agent-writable directory.
  const policies = join(root, 'artifacts/sandbox-policies', basename(dirname(directory)), basename(directory));
  await mkdir(policies, {recursive: true});
  const path = join(policies, renderer ? 'render.sb' : 'pi.sb');
  await writeFile(path, profile);
  return {path, env: {
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
    HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    // Chromium on macOS uses this variable instead of TMPDIR. Otherwise its
    // shared screenshot buffers go to the system temp directory and are denied.
    MAC_CHROMIUM_TMPDIR: join(directory, 'tmp'),
    VIDEO_RENDER_CONCURRENCY: process.env.VIDEO_RENDER_CONCURRENCY || '1',
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: join(directory, 'control/pi')
  }};
}
export function spawnIsolated(profile, executable, args, {cwd, env, ...options} = {}) {
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, executable, ...args], {cwd, env, detached: true, ...options});
  children.add(child); child.once('close', () => children.delete(child));
  return child;
}
export function stopProcess(child) {
  if (!child?.pid) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const stopped = new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer); child.removeListener('exit', finish); child.removeListener('close', finish);
      // The group may still contain a background tool after the main process exits.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      resolve();
    };
    const timer = setTimeout(finish, 3000); timer.unref();
    child.once('exit', finish); child.once('close', finish);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { finish(); }
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
  stopping.set(child, stopped); return stopped;
}
