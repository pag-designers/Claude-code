// Dev runner: Next dev server + esbuild watch + Electron pointed at the dev server.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import waitOn from 'wait-on';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.CLIPFERN_DEV_PORT ?? '3210';
const bin = (name) =>
  path.join(root, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
const children = [];
const run = (cmd, args, env = {}) => {
  const c = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.push(c);
  return c;
};

run(bin('next'), ['dev', 'renderer', '-p', port]);
run(process.execPath, [path.join(root, 'scripts/build-electron.mjs'), '--watch']);

await waitOn({
  resources: [
    `http-get://localhost:${port}`,
    path.join(root, 'dist-electron/main.cjs'),
    path.join(root, 'dist-electron/preload.cjs'),
  ],
  timeout: 120_000,
});
const electron = run(bin('electron'), ['.'], { CLIPFERN_DEV_URL: `http://localhost:${port}` });
electron.on('exit', () => {
  for (const c of children) c.kill();
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const c of children) c.kill();
});
