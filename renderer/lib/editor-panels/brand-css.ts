import type * as React from 'react';
import type { TextStyle } from '@shared/editor';

/** Scale of the in-tile preview: a tile is ~130 px wide and stands for a 1080 px canvas. */
export const PREVIEW_SCALE = 0.125;

/** CSS twin of a text style at tile scale (the compositor draws the real thing once it is on the timeline). */
export function textStyleCss(s: TextStyle, scale = PREVIEW_SCALE): React.CSSProperties {
  const css: React.CSSProperties = {
    fontFamily: `'${s.fontFamily}', var(--font-sans)`,
    fontWeight: s.weight,
    fontStyle: s.italic ? 'italic' : 'normal',
    fontSize: Math.max(9, Math.round(s.size * scale)),
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing * scale,
    color: s.color,
    textAlign: s.align,
    whiteSpace: 'pre-line',
  };
  if (s.stroke) {
    css.WebkitTextStroke = `${Math.max(1, Math.round(s.stroke.width * scale))}px ${s.stroke.color}`;
    css.paintOrder = 'stroke fill';
  }
  if (s.shadow)
    css.textShadow = `${Math.round(s.shadow.offsetX * scale)}px ${Math.round(s.shadow.offsetY * scale)}px ${Math.round(s.shadow.blur * scale)}px ${s.shadow.color}`;
  if (s.box) {
    css.background = `color-mix(in srgb, ${s.box.color} ${Math.round(s.box.opacity * 100)}%, transparent)`;
    css.padding = `${Math.round(s.box.padding * scale)}px`;
    css.borderRadius = Math.round(s.box.radius * scale);
  }
  return css;
}
