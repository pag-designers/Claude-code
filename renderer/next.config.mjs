import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  outputFileTracingRoot: path.join(here, '..'),
  typescript: { ignoreBuildErrors: false },
  // The renderer is only ever loaded inside Electron (app:// in prod, localhost in dev).
};
export default nextConfig;
