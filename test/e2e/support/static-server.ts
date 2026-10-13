import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Serves the exported renderer (renderer/out) AND the generated media assets under /__assets/, with HTTP Range support
 * (Chromium needs 206 responses to seek inside <video>). Everything is same-origin, so "no external requests" holds.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};

export function serveApp(
  outDir: string,
  assetsDir?: string,
): Promise<{ url: string; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0]!;
    const u = decodeURIComponent(raw);
    const isAsset = u.startsWith('/__assets/');
    const root = isAsset ? assetsDir : outDir;
    if (!root) return void res.writeHead(404).end('no assets');
    const rel = isAsset ? u.slice('/__assets/'.length) : u;
    let file = path.join(root, rel);
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return void res.writeHead(404).end('not found');
    if (isAsset) hits.push(rel);
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-length': size,
      'cache-control': isAsset ? 'max-age=600' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
        hits,
      }),
    ),
  );
}
