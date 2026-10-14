/** Tiny filtergraph builder: labelled chains, inputs, and option quoting. */
import { escapeFilterPath } from '../render/filters';
import { num } from './pl';

/** Single-quotes an expression / value so `,` `:` `;` `[` `]` `=` survive the graph + option parsers. */
export const q = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

export type OptValue = string | number | boolean | undefined;

/** `name=k=v:k=v`; strings are used verbatim (quote expressions with q()), numbers are formatted. */
export function filt(name: string, opts?: Record<string, OptValue> | string): string {
  if (opts === undefined) return name;
  if (typeof opts === 'string') return `${name}=${opts}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === 'number' ? num(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v}`);
  }
  return parts.length ? `${name}=${parts.join(':')}` : name;
}

/** A file path as a filter option value (two-level escaping, see render/filters). */
export const pathOpt = (p: string): string => escapeFilterPath(p);

export class Graph {
  readonly chains: string[] = [];
  /** Per-input ffmpeg arguments (`-ss .. -t .. -i file`). */
  readonly inputs: string[][] = [];
  private seq = 0;

  constructor(private readonly inputBase = 0) {}

  addInput(args: string[]): number {
    this.inputs.push(args);
    return this.inputBase + this.inputs.length - 1;
  }

  label(prefix = 'n'): string {
    return `${prefix}${this.seq++}`;
  }

  /** `[in1][in2]f1,f2[out]`. Returns `out`. */
  add(ins: string[], filters: string[], out?: string): string {
    const o = out ?? this.label();
    this.chains.push(`${ins.map((i) => `[${i}]`).join('')}${filters.join(',')}[${o}]`);
    return o;
  }

  /** `src` with no input pad (sources like color / anullsrc). */
  source(filters: string[], out?: string): string {
    return this.add([], filters, out);
  }

  text(): string {
    return this.chains.join(';\n');
  }
}

/** Accumulates filters on one stream and flushes them into a labelled chain when a multi-input step is needed. */
export class Chain {
  private pending: string[] = [];
  constructor(
    private readonly g: Graph,
    public label: string,
  ) {}

  push(...f: (string | null | undefined | false)[]): this {
    for (const x of f) if (x) this.pending.push(x);
    return this;
  }

  /** Emits pending filters; returns the current stream label. */
  flush(): string {
    if (this.pending.length > 0) {
      this.label = this.g.add([this.label], this.pending);
      this.pending = [];
    }
    return this.label;
  }
}
