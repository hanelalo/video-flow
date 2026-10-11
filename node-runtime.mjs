export const MIN_NODE_VERSION = '22.19.0';

export function assertNodeRuntime() {
  const current = process.versions.node.split('.').map(Number);
  const minimum = MIN_NODE_VERSION.split('.').map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] > minimum[i]) return;
    if (current[i] < minimum[i]) {
      throw new Error(`Video Flow 和 Pi 需要 Node.js >= ${MIN_NODE_VERSION}；当前为 ${process.version}（${process.execPath}）。请切换 Node 版本后重新运行 npm start；使用 nvm 时可运行 nvm install && nvm use。项目工程与 Pi 会话会保留。`);
    }
  }
}
