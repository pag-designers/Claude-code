import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny logger: ring buffer (for Diagnostics) + optional file sink.
 * Everything passes through `redact()` so API keys never reach logs (BRIEF §1.7).
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /(?<=Bearer\s)[A-Za-z0-9._~+/=-]{12,}/g,
  /(?<=(?:api[_-]?key|secret|token|password)["'=:\s]{1,4})[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private ring: string[] = [];
  private stream: fs.WriteStream | null = null;

  constructor(
    private readonly maxLines = 2000,
    private readonly echo = true,
  ) {}

  attachFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream?.end();
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  private write(level: LogLevel, scope: string, msg: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`;
    this.ring.push(line);
    if (this.ring.length > this.maxLines) this.ring.splice(0, this.ring.length - this.maxLines);
    this.stream?.write(line + '\n');
    if (this.echo) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else if (process.env.CLIPFERN_DEBUG) console.warn(line);
    }
  }

  scoped(scope: string) {
    return {
      debug: (m: string) => this.write('debug', scope, m),
      info: (m: string) => this.write('info', scope, m),
      warn: (m: string) => this.write('warn', scope, m),
      error: (m: string) => this.write('error', scope, m),
    };
  }

  dump(): string {
    return this.ring.join('\n');
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export const logger = new Logger();
export type ScopedLogger = ReturnType<Logger['scoped']>;
