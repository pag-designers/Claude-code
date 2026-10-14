'use client';

import * as React from 'react';
import { Play } from 'lucide-react';
import type { TextAnimation, TextStyle } from '@shared/editor';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hexToRgba } from '@/lib/brand/helpers';

/** `n` canvas px (1080 wide) as a fraction of the frame width, in container-query units. */
const cq = (n: number) => `${(n / 1080) * 100}cqw`;

export interface TextPreviewProps {
  style: TextStyle;
  text: string;
  /** Vertical centre, % of the frame height. null = centred (list cards). */
  yPct?: number | null;
  animIn?: TextAnimation;
  animOut?: TextAnimation;
  /** Bump to replay the animation. */
  replayKey?: number;
  aspect?: '9:16' | '16:9' | '16:10';
  className?: string;
}

/** CSS approximation of the editor's text rendering (stroke, shadow, box, alignment), sized like a 1080 px wide canvas. */
export function textCss(style: TextStyle): React.CSSProperties {
  const css: React.CSSProperties = {
    fontFamily: `"${style.fontFamily}", var(--font-sans)`,
    fontWeight: style.weight,
    fontStyle: style.italic ? 'italic' : 'normal',
    fontSize: cq(style.size),
    color: style.color,
    textAlign: style.align,
    letterSpacing: cq(style.letterSpacing),
    lineHeight: style.lineHeight,
    maxWidth: style.maxWidth ? cq(style.maxWidth) : '86cqw',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  };
  if (style.stroke && style.stroke.width > 0) {
    css.WebkitTextStroke = `${cq(style.stroke.width * 2)} ${style.stroke.color}`;
    css.paintOrder = 'stroke fill';
  }
  if (style.shadow) {
    const sh = style.shadow;
    css.textShadow = `${cq(sh.offsetX)} ${cq(sh.offsetY)} ${cq(sh.blur)} ${hexToRgba(sh.color, sh.opacity)}`;
  }
  if (style.box) {
    css.background = hexToRgba(style.box.color, style.box.opacity);
    css.padding = cq(style.box.padding);
    css.borderRadius = cq(style.box.radius);
  }
  return css;
}

type Kf = Keyframe[];
function keyframes(a: TextAnimation, dir: 'in' | 'out'): Kf | null {
  const rev = (k: Kf) => (dir === 'in' ? k : [...k].reverse());
  switch (a.type) {
    case 'none':
      return null;
    case 'fade':
      return rev([{ opacity: 0 }, { opacity: 1 }]);
    case 'pop':
      return rev([
        { opacity: 0, transform: 'scale(0.55)' },
        { opacity: 1, transform: 'scale(1.08)', offset: 0.7 },
        { opacity: 1, transform: 'scale(1)' },
      ]);
    case 'scale':
      return rev([
        { opacity: 0, transform: 'scale(0.3)' },
        { opacity: 1, transform: 'scale(1)' },
      ]);
    case 'slide':
      return rev([
        { opacity: 0, transform: 'translateY(40%)' },
        { opacity: 1, transform: 'translateY(0)' },
      ]);
    case 'bounce':
      return rev([
        { opacity: 0, transform: 'translateY(-70%)' },
        { opacity: 1, transform: 'translateY(0)', offset: 0.6 },
        { transform: 'translateY(-8%)', offset: 0.78 },
        { transform: 'translateY(0)' },
      ]);
    case 'typewriter':
      return rev([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }]);
  }
}

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A frame with the styled sample text. With `animIn`/`animOut` it plays in → hold → out once whenever the animation
 * settings or `replayKey` change (never when the person prefers reduced motion).
 */
export function TextStylePreview({
  style,
  text,
  yPct = null,
  animIn,
  animOut,
  replayKey = 0,
  aspect = '16:10',
  className,
}: TextPreviewProps) {
  const inner = React.useRef<HTMLDivElement | null>(null);
  const inKey = animIn ? `${animIn.type}:${animIn.durationSec}` : '';
  const outKey = animOut ? `${animOut.type}:${animOut.durationSec}` : '';

  React.useEffect(() => {
    const el = inner.current;
    if (!el || (!animIn && !animOut) || reduced()) return;
    let alive = true;
    const anims: Animation[] = [];
    const play = async (kf: Kf | null, ms: number, fill: FillMode = 'both') => {
      if (!kf || !alive) return;
      const a = el.animate(kf, {
        duration: Math.max(1, ms * 1000),
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        fill,
      });
      anims.push(a);
      await a.finished.catch(() => undefined);
    };
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    void (async () => {
      if (animIn) await play(keyframes(animIn, 'in'), animIn.durationSec, 'backwards');
      await sleep(1100);
      if (alive && animOut && animOut.type !== 'none') {
        await play(keyframes(animOut, 'out'), animOut.durationSec, 'forwards');
        await sleep(350);
        if (alive) for (const a of anims) a.cancel();
      }
    })();
    return () => {
      alive = false;
      for (const a of anims) a.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inKey, outKey, replayKey]);

  const ratio = aspect === '9:16' ? '9 / 16' : aspect === '16:9' ? '16 / 9' : '16 / 10';
  const pos: React.CSSProperties =
    yPct === null
      ? { top: '50%', transform: 'translateY(-50%)' }
      : { top: `${yPct}%`, transform: 'translateY(-50%)' };
  return (
    <div
      data-testid="text-style-preview"
      className={cn(
        'relative w-full overflow-hidden rounded-lg border border-border-strong',
        className,
      )}
      style={{
        aspectRatio: ratio,
        containerType: 'inline-size',
        backgroundImage:
          'linear-gradient(155deg, var(--neutral-600) 0%, var(--neutral-800) 55%, var(--neutral-900) 100%)',
      }}
    >
      <div className="absolute inset-x-0 flex justify-center" style={pos}>
        <div ref={inner} style={textCss(style)} data-testid="text-style-sample">
          {text}
        </div>
      </div>
    </div>
  );
}

export function ReplayButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="xs" variant="outline" onClick={onClick} aria-label="Replay animation">
      <Play /> Replay
    </Button>
  );
}
