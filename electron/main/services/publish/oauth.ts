import crypto from 'node:crypto';
import http from 'node:http';
import type { Platform } from '@shared/publish';

export const DEFAULT_OAUTH_PORT = 53682;
export const OAUTH_TIMEOUT_MS = 5 * 60_000;

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'timeout' | 'canceled' | 'busy' | 'port' | 'state',
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

export interface OAuthLoopbackDeps {
  /** The fixed loopback port the user registered in the developer app. */
  port(): number;
  /** Opens the consent URL in the system browser (never an in-app window: users must see the real address bar). */
  openExternal(url: string): Promise<void>;
  timeoutMs?: number;
  log?: (m: string) => void;
}

export interface AuthorizeResult {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

const b64url = (b: Buffer): string => b.toString('base64url');

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Clipfern</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><style>` +
  `body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#101412;color:#e8efe9}` +
  `main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{opacity:.75;margin:0}` +
  `</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * OAuth for a desktop app (RFC 8252): the system browser opens the consent page, the platform redirects to
 * `http://127.0.0.1:<port>/oauth/<platform>` where a short-lived loopback server picks up the code. PKCE (S256) and a
 * random `state` protect the exchange. One flow at a time; the server only exists while a flow is running.
 */
export class OAuthLoopback {
  private active: {
    platform: Platform;
    cancel(reason: OAuthFlowError): void;
  } | null = null;

  constructor(private readonly d: OAuthLoopbackDeps) {}

  redirectUri(platform: Platform): string {
    return `http://127.0.0.1:${this.d.port()}/oauth/${platform}`;
  }

  isActive(platform?: Platform): boolean {
    return !!this.active && (!platform || this.active.platform === platform);
  }

  cancel(platform: Platform): boolean {
    if (!this.active || this.active.platform !== platform) return false;
    this.active.cancel(new OAuthFlowError('The connection was canceled.', 'canceled'));
    return true;
  }

  async authorize(
    platform: Platform,
    authUrl: (a: { redirectUri: string; state: string; codeChallenge: string }) => string,
  ): Promise<AuthorizeResult> {
    if (this.active)
      throw new OAuthFlowError(
        'Another account connection is still open. Finish or cancel it first.',
        'busy',
      );
    const port = this.d.port();
    const redirectUri = this.redirectUri(platform);
    const state = b64url(crypto.randomBytes(24));
    const pkce = newPkce();
    const expectedPath = `/oauth/${platform}`;

    return new Promise<AuthorizeResult>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== expectedPath) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
          return;
        }
        const reply = (status: number, title: string, body: string) =>
          res
            .writeHead(status, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            .end(page(esc(title), esc(body)));
        const gotState = url.searchParams.get('state') ?? '';
        const a = Buffer.from(gotState);
        const b = Buffer.from(state);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          reply(400, 'Link expired', 'This sign-in link does not belong to the open Clipfern window. Start again in Clipfern.');
          return; // a stray request must not end the real flow
        }
        const err = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (err) {
          const desc = url.searchParams.get('error_description') ?? err;
          reply(200, 'Not connected', 'You can close this tab and return to Clipfern.');
          finish(
            new OAuthFlowError(
              err === 'access_denied' ? 'The sign-in was canceled on the platform.' : `The platform refused the sign-in: ${desc}`,
              'denied',
            ),
          );
          return;
        }
        if (!code) {
          reply(400, 'Missing code', 'The platform did not send a sign-in code.');
          return;
        }
        reply(200, 'Connected', 'You can close this tab and return to Clipfern.');
        finish(null, { code, redirectUri, codeVerifier: pkce.verifier });
      });

      const finish = (err: OAuthFlowError | null, value?: AuthorizeResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.active = null;
        // give the browser a beat to receive the page before the socket closes
        server.close();
        server.closeAllConnections?.();
        if (err) reject(err);
        else resolve(value as AuthorizeResult);
      };

      server.on('error', (e: NodeJS.ErrnoException) => {
        finish(
          new OAuthFlowError(
            e.code === 'EADDRINUSE'
              ? `Port ${port} is already in use by another program. Free it or choose another port in Settings → Scheduler, then register the new redirect URI in the developer app.`
              : `Could not listen for the sign-in redirect: ${e.message}`,
            'port',
          ),
        );
      });

      this.active = { platform, cancel: (r) => finish(r) };
      server.listen(port, '127.0.0.1', () => {
        timer = setTimeout(
          () => finish(new OAuthFlowError('The sign-in was not completed within 5 minutes.', 'timeout')),
          this.d.timeoutMs ?? OAUTH_TIMEOUT_MS,
        );
        timer.unref?.();
        let url: string;
        try {
          url = authUrl({ redirectUri, state, codeChallenge: pkce.challenge });
        } catch (e) {
          finish(new OAuthFlowError(e instanceof Error ? e.message : String(e), 'denied'));
          return;
        }
        this.d.log?.(`oauth: opening the ${platform} consent page`);
        void this.d.openExternal(url).catch((e: unknown) =>
          finish(
            new OAuthFlowError(
              `Could not open your browser: ${e instanceof Error ? e.message : String(e)}`,
              'denied',
            ),
          ),
        );
      });
    });
  }
}
