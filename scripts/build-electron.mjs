import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

execFileSync(process.execPath, [path.join(root, 'scripts/gen-migrations.mjs')], {
  stdio: 'inherit',
});

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
  alias: { '@shared': './shared', '@main': './electron/main' },
  // Native / generated modules must stay external and be shipped in node_modules.
  external: [
    'electron',
    '@prisma/client',
    '.prisma/client',
    '@prisma/adapter-libsql',
    '@libsql/client',
    'ffmpeg-static',
    'ffprobe-static',
  ],
};

const targets = [
  { ...common, entryPoints: ['electron/main/index.ts'], outfile: 'dist-electron/main.cjs' },
  { ...common, entryPoints: ['electron/preload/index.ts'], outfile: 'dist-electron/preload.cjs' },
];

if (watch) {
  for (const t of targets) await (await context(t)).watch();
  console.log('esbuild watching…');
} else {
  await Promise.all(targets.map((t) => build(t)));
}
