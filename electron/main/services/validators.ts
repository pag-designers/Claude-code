import type { ValidationResult, ValidationService } from '@shared/domain';
import type { Settings } from '@shared/settings';
import type { SecretStore } from './secrets';
import { resolveStorageProvider } from './storage/factory';

type Fetch = typeof fetch;

const timed = async (
  fn: () => Promise<Omit<ValidationResult, 'latencyMs'>>,
): Promise<ValidationResult> => {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, latencyMs: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      message: networkMessage(e),
      detail: null,
      latencyMs: Date.now() - t0,
    };
  }
};

function networkMessage(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err.name === 'TimeoutError' || err.name === 'AbortError')
    return 'Timed out — the service did not respond in 15 s.';
  const code = err.cause?.code;
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN')
    return `Network error (${code}) — check your internet connection.`;
  return err.message || 'Unknown error';
}

const missing = (what: string): ValidationResult => ({
  ok: false,
  message: `No ${what} saved yet.`,
  detail: null,
  latencyMs: 0,
});

export class Validators {
  constructor(
    private readonly deps: {
      secrets: SecretStore;
      getSettings: () => Promise<Settings>;
      fetchImpl?: Fetch;
      anthropicBaseUrl?: string;
      whopBaseUrl?: string;
      pexelsBaseUrl?: string;
      pixabayBaseUrl?: string;
    },
  ) {}

  private get f(): Fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  run(service: ValidationService): Promise<ValidationResult> {
    switch (service) {
      case 'anthropic':
        return this.anthropic();
      case 'storage':
        return this.storage();
      case 'pexels':
        return this.pexels();
      case 'pixabay':
        return this.pixabay();
      case 'whop':
        return this.whop();
    }
  }

  async anthropic(): Promise<ValidationResult> {
    const key = this.deps.secrets.get('anthropic.apiKey');
    if (!key) return missing('Anthropic API key');
    const settings = await this.deps.getSettings();
    const base = this.deps.anthropicBaseUrl ?? 'https://api.anthropic.com';
    return timed(async () => {
      const res = await this.f(`${base}/v1/models?limit=100`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403)
        return {
          ok: false,
          message: 'Anthropic rejected this key (401/403). Re-copy it from console.anthropic.com.',
          detail: null,
        };
      if (!res.ok)
        return {
          ok: false,
          message: `Anthropic returned HTTP ${res.status}.`,
          detail: await safeText(res),
        };
      const body = (await res.json()) as { data?: { id: string }[] };
      const ids = new Set((body.data ?? []).map((m) => m.id));
      const unknown = [settings.modelSmart, settings.modelFast].filter(
        (m) => ids.size && !ids.has(m),
      );
      return {
        ok: true,
        message: 'Key is valid.',
        detail: unknown.length
          ? `Note: configured model(s) not listed for this key: ${unknown.join(', ')} — adjust them under Models & Budget.`
          : `${ids.size} models available.`,
      };
    });
  }

  async storage(): Promise<ValidationResult> {
    const settings = await this.deps.getSettings();
    const r = resolveStorageProvider(settings, this.deps.secrets);
    if (!r.ok) return { ok: false, message: r.reason, detail: null, latencyMs: 0 };
    return timed(async () => {
      const { detail } = await r.provider.check();
      return { ok: true, message: 'Connected.', detail };
    }).then((res) => (res.ok ? res : { ...res, message: res.message }));
  }

  async pexels(): Promise<ValidationResult> {
    const key = this.deps.secrets.get('pexels.apiKey');
    if (!key) return missing('Pexels API key');
    const base = this.deps.pexelsBaseUrl ?? 'https://api.pexels.com';
    return timed(async () => {
      const res = await this.f(`${base}/videos/search?query=nature&per_page=1`, {
        headers: { Authorization: key },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403)
        return { ok: false, message: 'Pexels rejected this key.', detail: null };
      if (!res.ok)
        return {
          ok: false,
          message: `Pexels returned HTTP ${res.status}.`,
          detail: await safeText(res),
        };
      const remaining = res.headers.get('x-ratelimit-remaining');
      return {
        ok: true,
        message: 'Key is valid.',
        detail: remaining ? `${remaining} requests left this month.` : null,
      };
    });
  }

  async pixabay(): Promise<ValidationResult> {
    const key = this.deps.secrets.get('pixabay.apiKey');
    if (!key) return missing('Pixabay API key');
    const base = this.deps.pixabayBaseUrl ?? 'https://pixabay.com';
    return timed(async () => {
      const res = await this.f(`${base}/api/?key=${encodeURIComponent(key)}&q=nature&per_page=3`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 400 || res.status === 401 || res.status === 403)
        return { ok: false, message: 'Pixabay rejected this key.', detail: await safeText(res) };
      if (!res.ok)
        return {
          ok: false,
          message: `Pixabay returned HTTP ${res.status}.`,
          detail: await safeText(res),
        };
      const remaining = res.headers.get('x-ratelimit-remaining');
      return {
        ok: true,
        message: 'Key is valid.',
        detail: remaining ? `${remaining} requests left this window.` : null,
      };
    });
  }

  async whop(): Promise<ValidationResult> {
    const key = this.deps.secrets.get('whop.apiKey');
    if (!key) return missing('Whop API key');
    const base = this.deps.whopBaseUrl ?? 'https://api.whop.com/api/v1';
    return timed(async () => {
      const res = await this.f(`${base}/accounts/me`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403)
        return {
          ok: false,
          message: 'Whop rejected this key (needs an Account API key with read access).',
          detail: null,
        };
      if (!res.ok)
        return {
          ok: false,
          message: `Whop returned HTTP ${res.status}.`,
          detail: await safeText(res),
        };
      const body = (await res.json()) as { id?: string; title?: string };
      return {
        ok: true,
        message: 'Key is valid.',
        detail: body.title ? `Account: ${body.title}` : (body.id ?? null),
      };
    });
  }
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return null;
  }
}
