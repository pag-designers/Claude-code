import type { Metadata } from 'next';
import './globals.css';
import { ClientRoot } from '@/components/shell/client-root';
import { PRE_PAINT_SCRIPT } from '@/lib/prefs';

export const metadata: Metadata = {
  title: 'Clipfern',
  description: 'Turn long YouTube videos into clips worth posting.',
};

const FONTS = ['inter-latin-wght-normal.woff2', 'space-grotesk-latin-wght-normal.woff2'];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="dark light" />
        {FONTS.map((f) => (
          <link
            key={f}
            rel="preload"
            href={`/fonts/${f}`}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
        {/* Sets data-theme / sidebar / platform before first paint: no theme flash. */}
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_SCRIPT }} />
      </head>
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  );
}
