'use client';

import * as React from 'react';
import type { TransformHandles } from '@/lib/editor/compositor/api';
import { safeRect } from './layout';

/**
 * Transparent SVG layer over the preview canvas: safe-area guides, rule-of-thirds grid, the selection's transform handles
 * and snap guides. Coordinates are PREVIEW (drawing-buffer) px — the same space the compositor reports handles in — so the
 * SVG's viewBox is the buffer size and `k` (buffer px per CSS px) keeps handle sizes constant on screen. Colours are
 * design tokens (CSS variables) only. Purely presentational: pointer handling lives in the stage.
 */
export interface SelectionOverlay {
  itemId: string;
  handles: TransformHandles;
  /** The one that shows scale / rotate handles (single selection). */
  interactive: boolean;
}

export interface SafeAreaSpec {
  id: string;
  label: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface OverlayProps {
  bufW: number;
  bufH: number;
  k: number;
  safeArea: SafeAreaSpec | null;
  showGrid: boolean;
  selections: SelectionOverlay[];
  /** Guides to draw, preview px (already scaled). */
  guides: { x?: number; y?: number }[];
  /** Handles hidden while text is edited inline. */
  hideHandles?: boolean;
}

const HANDLE_CSS = 9;
const ROT_R_CSS = 5;

export function PreviewOverlay(p: OverlayProps) {
  const { bufW, bufH, k } = p;
  const hs = HANDLE_CSS * k;
  const sa = p.safeArea;
  const safe = sa ? safeRect(sa, bufW, bufH) : null;
  return (
    <svg
      data-testid="preview-overlay"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      viewBox={`0 0 ${bufW} ${bufH}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {safe && sa ? (
        <g data-testid="safe-area-guides" data-safe-area={sa.id}>
          <path
            fillRule="evenodd"
            d={`M0 0H${bufW}V${bufH}H0Z M${safe.x} ${safe.y}H${safe.x + safe.w}V${safe.y + safe.h}H${safe.x}Z`}
            style={{ fill: 'color-mix(in srgb, var(--warning) 14%, transparent)' }}
          />
          <rect
            x={safe.x}
            y={safe.y}
            width={safe.w}
            height={safe.h}
            fill="none"
            strokeDasharray={`${6 * k} ${4 * k}`}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--warning)', strokeWidth: 1.25 }}
          />
          <text
            x={safe.x + 6 * k}
            y={safe.y + 14 * k}
            fontSize={10.5 * k}
            fontWeight={600}
            style={{ fill: 'var(--warning)' }}
          >
            {sa.label} safe area
          </text>
        </g>
      ) : null}

      {p.showGrid ? (
        <g data-testid="grid-guides" style={{ stroke: 'var(--foreground)', opacity: 0.38 }}>
          {[1, 2].map((i) => (
            <React.Fragment key={i}>
              <line
                x1={(bufW * i) / 3}
                y1={0}
                x2={(bufW * i) / 3}
                y2={bufH}
                vectorEffect="non-scaling-stroke"
                strokeWidth={1}
              />
              <line
                x1={0}
                y1={(bufH * i) / 3}
                x2={bufW}
                y2={(bufH * i) / 3}
                vectorEffect="non-scaling-stroke"
                strokeWidth={1}
              />
            </React.Fragment>
          ))}
        </g>
      ) : null}

      {p.guides.map((g, i) =>
        g.x !== undefined ? (
          <line
            key={`gx${i}`}
            data-testid="snap-guide"
            x1={g.x}
            y1={0}
            x2={g.x}
            y2={bufH}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--primary-text)', strokeWidth: 1 }}
          />
        ) : g.y !== undefined ? (
          <line
            key={`gy${i}`}
            data-testid="snap-guide"
            x1={0}
            y1={g.y}
            x2={bufW}
            y2={g.y}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--primary-text)', strokeWidth: 1 }}
          />
        ) : null,
      )}

      {p.hideHandles
        ? null
        : p.selections.map((s) => {
            const c = s.handles.corners;
            const pts = c.map((q) => `${q.x},${q.y}`).join(' ');
            return (
              <g key={s.itemId} data-testid="transform-handles" data-item-id={s.itemId}>
                <polygon
                  points={pts}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: 'var(--primary)', strokeWidth: 1.5 }}
                />
                {s.interactive ? (
                  <>
                    <line
                      x1={(c[0].x + c[1].x) / 2}
                      y1={(c[0].y + c[1].y) / 2}
                      x2={s.handles.rotationHandle.x}
                      y2={s.handles.rotationHandle.y}
                      vectorEffect="non-scaling-stroke"
                      style={{ stroke: 'var(--primary)', strokeWidth: 1 }}
                    />
                    <circle
                      data-testid="handle-rotate"
                      cx={s.handles.rotationHandle.x}
                      cy={s.handles.rotationHandle.y}
                      r={ROT_R_CSS * k}
                      vectorEffect="non-scaling-stroke"
                      style={{
                        fill: 'var(--background)',
                        stroke: 'var(--primary)',
                        strokeWidth: 1.5,
                      }}
                    />
                    {(['nw', 'ne', 'se', 'sw'] as const).map((n, i) => {
                      const q = c[i] as { x: number; y: number };
                      return (
                        <rect
                          key={n}
                          data-testid={`handle-scale-${n}`}
                          x={q.x - hs / 2}
                          y={q.y - hs / 2}
                          width={hs}
                          height={hs}
                          rx={1.5 * k}
                          vectorEffect="non-scaling-stroke"
                          style={{
                            fill: 'var(--background)',
                            stroke: 'var(--primary)',
                            strokeWidth: 1.5,
                          }}
                        />
                      );
                    })}
                  </>
                ) : null}
              </g>
            );
          })}
    </svg>
  );
}
