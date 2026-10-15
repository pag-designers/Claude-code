import { execFile } from 'node:child_process';
import os from 'node:os';
import type { Hardware } from '@shared/domain';

function nvidiaSmi(): Promise<{ name: string; vramMb: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const [name, mem] = String(stdout).split('\n')[0]?.split(',') ?? [];
        if (!name) return resolve(null);
        resolve({ name: name.trim(), vramMb: Number(mem?.trim()) || 0 });
      },
    );
  });
}

export async function detectHardware(encoders: string[]): Promise<Hardware> {
  const cpus = os.cpus();
  const nv = await nvidiaSmi();
  const apple = process.platform === 'darwin' && process.arch === 'arm64';
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    cpuCores: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    gpu: nv
      ? { kind: 'nvidia', name: nv.name, vramMb: nv.vramMb }
      : apple
        ? { kind: 'apple', name: 'Apple Silicon (Metal)', vramMb: null }
        : { kind: 'none', name: null, vramMb: null },
    encoders,
  };
}
