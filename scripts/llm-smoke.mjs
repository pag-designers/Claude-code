// Live smoke test for the Claude layer (electron/main/services/llm). Needs a real key unless --dry-run.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/llm-smoke.mjs <transcript.json> [--windows=2]
//       [--window-sec=600] [--preset=30-60] [--clips=10] [--prompt="only funny moments"] [--dry-run]
//
//   CP2 mode (hooks, metadata, highlights, 3-turn chat with a tool call, optional thumbnails):
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/llm-smoke.mjs <transcript.json> --cp2 [--frames=<dir of jpgs>]
//       [--prompt="steer the highlight reel"]      (--cp2 --dry-run: prompt sizes + cost per call kind, no key)
//
// Bundles electron/main/services/llm/smoke.ts with esbuild (same aliases as build-electron.mjs) into a
// temp file and runs it. Full option docs: the header of electron/main/services/llm/smoke.ts.
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Map(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : 'true'];
    }),
);
const file = args.find((a) => !a.startsWith('--'));
if (!file || flags.has('help')) {
  console.error(
    'usage: ANTHROPIC_API_KEY=... node scripts/llm-smoke.mjs <transcript.json> [--windows=2] [--window-sec=600] [--preset=30-60] [--clips=10] [--prompt="..."] [--dry-run] [--cp2 [--frames=DIR] [--long-hours=6]]',
  );
  process.exit(file ? 0 : 2);
}
const dryRun = flags.has('dry-run');
const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
if (!dryRun && !apiKey) {
  console.error(
    'ANTHROPIC_API_KEY is not set (use --dry-run to only preview prompt sizes and cost).',
  );
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`transcript not found: ${file}`);
  process.exit(2);
}

const out = path.join(os.tmpdir(), `clipfern-llm-smoke-${process.pid}.cjs`);
try {
  await build({
    entryPoints: [path.join(root, 'electron/main/services/llm/smoke.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    logLevel: 'error',
    absWorkingDir: root,
    alias: { '@shared': './shared', '@main': './electron/main' },
  });
  const { runSmoke, runSmokeCp2 } = createRequire(import.meta.url)(out);
  const num = (k) => (flags.has(k) ? Number(flags.get(k)) : undefined);
  const run = flags.has('cp2') ? runSmokeCp2 : runSmoke;
  await run(apiKey, path.resolve(file), {
    frames: flags.get('frames') ? path.resolve(flags.get('frames')) : undefined,
    longHours: num('long-hours'),
    windows: num('windows'),
    windowSec: num('window-sec'),
    preset: flags.get('preset'),
    clips: num('clips'),
    prompt: flags.get('prompt'),
    dryRun,
    baseUrl: process.env.CLIPFERN_LLM_BASE_URL || undefined, // e.g. a local stub
  });
} catch (e) {
  // The LLM layer redacts keys in its own messages; never print raw error objects (headers).
  console.error(`\nSMOKE FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(out, { force: true });
}
