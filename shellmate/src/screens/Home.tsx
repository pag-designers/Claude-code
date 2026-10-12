import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BookIcon, CheckIcon, ChestIcon, CrownIcon, LockIcon, StarIcon } from '../components/Icons';
import Kip from '../components/Kip';
import Modal from '../components/Modal';
import RichText, { CodeBlock } from '../components/RichText';
import { units } from '../content';
import {
  currentLesson,
  darker,
  isLessonDone,
  isLessonUnlocked,
  isMissionUnlocked,
  isUnitLessonsDone,
  lastCompletedLesson,
  textOn,
} from '../lib/progress';
import { sfx } from '../lib/sound';
import { useGame } from '../store/useGame';
import { useNav } from '../store/useNav';
import type { Lesson, Unit } from '../types';

const GOLD = '#ffc83d';
const LOCKED_BG = 'var(--surface-2)';

type NodeState = 'locked' | 'current' | 'available' | 'done';

type PathNode =
  | { kind: 'lesson'; key: string; lesson: Lesson; state: NodeState }
  | { kind: 'mission'; key: string; state: NodeState };

function pathOffset(i: number): number {
  return Math.round(Math.sin((i * Math.PI) / 4) * 72);
}

export default function Home() {
  const game = useGame();
  const play = useNav((s) => s.play);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [guide, setGuide] = useState<Unit | null>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  const current = currentLesson(game);

  useEffect(() => {
    const t = window.setTimeout(() => focusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
    return () => window.clearTimeout(t);
  }, []);

  if (units.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 pt-16 text-center">
        <Kip mood="thinking" size={160} />
        <h2 className="mt-6 text-2xl font-black">No lessons yet</h2>
        <p className="mt-2 font-semibold text-muted">Kip is still writing the course. Check back soon!</p>
      </div>
    );
  }

  // The node we scroll to: the current lesson, else the first open mission, else the very last node.
  const focusKey =
    current?.lesson.id ??
    units.filter((u) => isMissionUnlocked(game, u) && !game.completedMissions[u.id]).map((u) => `mission:${u.id}`)[0] ??
    `mission:${units[units.length - 1].id}`;

  return (
    <div className="px-4 pt-4">
      {units.map((unit) => {
        const gold = !!game.goldUnits[unit.id];
        const allDone = isUnitLessonsDone(game, unit);
        const nodes: PathNode[] = [
          ...unit.lessons.map((lesson): PathNode => {
            const done = isLessonDone(game, lesson.id);
            const state: NodeState = done ? 'done' : current?.lesson.id === lesson.id ? 'current' : isLessonUnlocked(game, lesson.id) ? 'available' : 'locked';
            return { kind: 'lesson', key: lesson.id, lesson, state };
          }),
          {
            kind: 'mission',
            key: `mission:${unit.id}`,
            state: game.completedMissions[unit.id] ? 'done' : allDone ? 'available' : 'locked',
          },
        ];
        const nextLegendary = unit.lessons.find((l) => !game.completedLessons[l.id]?.legendary);

        return (
          <section key={unit.id} className="mb-10">
            <UnitBanner
              unit={unit}
              gold={gold}
              legendaryReady={allDone && !gold && !!nextLegendary}
              onGuide={() => setGuide(unit)}
              onLegendary={() => nextLegendary && play({ mode: 'legendary', lessonId: nextLegendary.id })}
            />
            <div className="mt-14 flex flex-col items-center gap-6">
              {nodes.map((node, i) => {
                const offset = pathOffset(i);
                const isFocus = node.key === focusKey;
                return (
                  <div key={node.key} ref={isFocus ? focusRef : undefined} className={`relative w-full ${openKey === node.key ? 'z-20' : ''}`}>
                    <div className="flex justify-center" style={{ transform: `translateX(${offset}px)` }}>
                      <PathNodeButton
                        node={node}
                        unit={unit}
                        gold={gold}
                        onClick={() => {
                          sfx.tap();
                          setOpenKey(openKey === node.key ? null : node.key);
                        }}
                      />
                    </div>
                    {node.state === 'current' && (
                      <div className="pointer-events-none absolute top-1/2 -translate-y-1/2" style={{ left: `calc(50% + ${(offset >= 0 ? -125 : 125) - 45}px)` }}>
                        <Kip mood="encourage" size={90} />
                      </div>
                    )}
                    <AnimatePresence>
                      {openKey === node.key && (
                        <NodePopover
                          node={node}
                          unit={unit}
                          gold={gold}
                          allDone={allDone}
                          onClose={() => setOpenKey(null)}
                        />
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="flex flex-col items-center pb-8 text-center text-sm font-bold text-muted">
        <span className="text-3xl">🏁</span>
        More units coming soon
      </div>

      {openKey && <div className="fixed inset-0 z-10" onClick={() => setOpenKey(null)} aria-hidden />}

      <Modal open={!!guide} onClose={() => setGuide(null)} title={guide ? `Guidebook · ${guide.title}` : ''} wide>
        {guide && <Guidebook unit={guide} />}
      </Modal>
    </div>
  );
}

function UnitBanner({
  unit,
  gold,
  legendaryReady,
  onGuide,
  onLegendary,
}: {
  unit: Unit;
  gold: boolean;
  legendaryReady: boolean;
  onGuide: () => void;
  onLegendary: () => void;
}) {
  const bg = gold ? GOLD : unit.color;
  const fg = textOn(bg);
  return (
    <div className="rounded-3xl p-4" style={{ background: bg, color: fg, borderBottom: `5px solid ${darker(bg)}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-black uppercase tracking-widest opacity-80">
            Unit {unit.order}
            {gold && ' · Legendary'}
          </div>
          <h2 className="mt-0.5 text-xl font-black leading-tight">{unit.title}</h2>
          <p className="mt-1 text-sm font-semibold opacity-85">{unit.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            onClick={onGuide}
            className="flex items-center gap-1.5 rounded-xl border-2 px-3 py-2 text-xs font-black uppercase"
            style={{ borderColor: `color-mix(in srgb, ${fg} 35%, transparent)`, background: `color-mix(in srgb, ${fg} 10%, transparent)` }}
          >
            <BookIcon size={16} /> Guidebook
          </button>
          {gold ? (
            <span className="flex items-center gap-1 text-xs font-black uppercase">
              <CrownIcon size={22} /> Gold
            </span>
          ) : (
            legendaryReady && (
              <button onClick={onLegendary} className="btn3d btn3d-gold px-3 py-1.5 text-xs">
                <CrownIcon size={16} /> Legendary
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function PathNodeButton({ node, unit, gold, onClick }: { node: PathNode; unit: Unit; gold: boolean; onClick: () => void }) {
  const locked = node.state === 'locked';
  const big = node.state === 'current' || (node.kind === 'mission' && node.state === 'available');
  const color = locked ? LOCKED_BG : gold ? GOLD : unit.color;
  const size = big ? 84 : 72;
  const label =
    node.kind === 'lesson' ? `${node.lesson.title} (${node.state})` : `${unit.mission.title} mission (${node.state})`;

  let icon;
  if (node.kind === 'mission') icon = <ChestIcon size={38} className={locked ? 'opacity-50 grayscale' : ''} />;
  else if (locked) icon = <LockIcon size={30} />;
  else if (node.state === 'done') icon = gold ? <CrownIcon size={36} /> : <CheckIcon size={34} />;
  else icon = <StarIcon size={36} />;

  return (
    <div className="relative">
      {big && (
        <>
          <motion.span
            className="absolute -inset-2 rounded-full border-4"
            style={{ borderColor: color }}
            animate={{ scale: [1, 1.22], opacity: [0.7, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
          />
          {node.state === 'current' && (
            <motion.div
              className="absolute -top-12 left-1/2 z-10 -translate-x-1/2"
              animate={{ y: [0, -5, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <div className="card relative whitespace-nowrap rounded-xl px-3 py-1.5 text-sm font-black uppercase tracking-wide" style={{ color: unit.color }}>
                Start
                <span className="absolute -bottom-[9px] left-1/2 h-4 w-4 -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-line bg-surface" />
              </div>
            </motion.div>
          )}
        </>
      )}
      <motion.button
        onClick={onClick}
        aria-label={label}
        whileTap={{ y: 4 }}
        className={`relative grid place-items-center rounded-full ${locked ? 'text-muted' : ''}`}
        style={{
          width: size,
          height: size - 6,
          background: color,
          color: locked ? undefined : textOn(color),
          borderBottom: `7px solid ${locked ? 'var(--border)' : darker(color)}`,
        }}
      >
        {!locked && <span className="pointer-events-none absolute left-3 right-3 top-2 h-3 rounded-full bg-white/20" />}
        {icon}
      </motion.button>
    </div>
  );
}

function NodePopover({
  node,
  unit,
  gold,
  allDone,
  onClose,
}: {
  node: PathNode;
  unit: Unit;
  gold: boolean;
  allDone: boolean;
  onClose: () => void;
}) {
  const game = useGame();
  const play = useNav((s) => s.play);
  const locked = node.state === 'locked';
  const bg = locked ? 'var(--surface-2)' : gold ? GOLD : unit.color;
  const fg = locked ? 'var(--text)' : textOn(bg);
  const btnStyle = {
    '--btn': locked ? 'var(--surface)' : '#ffffff',
    '--btn-dark': locked ? 'var(--border)' : '#d6d6d6',
    color: locked ? 'var(--muted)' : gold ? '#c99412' : unit.color,
  } as CSSProperties;

  const start = (fn: () => void) => () => {
    sfx.tap();
    onClose();
    fn();
  };

  let title: string;
  let body: string;
  let actions: ReactNode;

  if (node.kind === 'mission') {
    title = `Mission: ${unit.mission.title}`;
    body = locked ? 'Finish every lesson in this unit to unlock the mission.' : unit.mission.intro;
    actions = locked ? (
      <button className="btn3d w-full" style={btnStyle} disabled>
        <LockIcon size={18} /> Locked
      </button>
    ) : (
      <button className="btn3d w-full" style={btnStyle} onClick={start(() => play({ mode: 'mission', unitId: unit.id }))}>
        {node.state === 'done' ? 'Replay mission' : `Start mission +${unit.mission.bonusXp} XP`}
      </button>
    );
  } else {
    const { lesson } = node;
    const record = game.completedLessons[lesson.id];
    title = lesson.title;
    body = locked ? 'Complete all levels above to unlock this!' : lesson.description;
    if (locked) {
      actions = (
        <button className="btn3d w-full" style={btnStyle} disabled>
          <LockIcon size={18} /> Locked
        </button>
      );
    } else if (node.state === 'done') {
      actions = (
        <div className="flex flex-col gap-2">
          {record && (
            <div className="text-xs font-extrabold uppercase tracking-wide opacity-80">
              Best accuracy {record.bestAccuracy}% · played {record.times}×{record.legendary ? ' · 👑 Legendary' : ''}
            </div>
          )}
          <button className="btn3d w-full" style={btnStyle} onClick={start(() => play({ mode: 'practice', lessonId: lesson.id }))}>
            Practice +XP
          </button>
          {allDone && !record?.legendary && (
            <button className="btn3d btn3d-gold w-full" onClick={start(() => play({ mode: 'legendary', lessonId: lesson.id }))}>
              <CrownIcon size={18} /> Legendary
            </button>
          )}
        </div>
      );
    } else {
      const heal = lastCompletedLesson(game);
      actions = (
        <div className="flex flex-col gap-2">
          {game.hearts === 0 && (
            <div className="text-sm font-extrabold opacity-90">💔 You're out of hearts. Practice a finished lesson to refill them.</div>
          )}
          {game.hearts === 0 && heal ? (
            <button className="btn3d w-full" style={btnStyle} onClick={start(() => play({ mode: 'practice', lessonId: heal.lesson.id }))}>
              Practice to heal
            </button>
          ) : (
            <button className="btn3d w-full" style={btnStyle} onClick={start(() => play({ mode: 'normal', lessonId: lesson.id }))}>
              Start +{lesson.exercises.length * 10} XP
            </button>
          )}
        </div>
      );
    }
  }

  return (
    <motion.div
      className="absolute inset-x-0 top-full z-20 mt-3 flex justify-center"
      initial={{ opacity: 0, y: -8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      <div className="relative w-[min(320px,100%)] rounded-2xl p-4 shadow-2xl" style={{ background: bg, color: fg }}>
        <span className="absolute -top-2 left-1/2 h-4 w-4 -translate-x-1/2 rotate-45" style={{ background: bg }} />
        <h3 className="text-lg font-black leading-tight">{title}</h3>
        <p className="mb-3 mt-1 text-sm font-semibold opacity-85">{body}</p>
        {actions}
      </div>
    </motion.div>
  );
}

function Guidebook({ unit }: { unit: Unit }) {
  return (
    <div className="space-y-6">
      <p className="text-sm font-semibold text-muted">Key ideas from every lesson in this unit.</p>
      {unit.lessons.map((lesson, i) => (
        <div key={lesson.id}>
          <div className="mb-2 text-xs font-black uppercase tracking-widest" style={{ color: unit.color }}>
            Lesson {i + 1} · {lesson.title}
          </div>
          <div className="space-y-3">
            {lesson.theory.map((card, j) => (
              <div key={j} className="rounded-2xl border-2 border-line bg-surface-2 p-4">
                <h4 className="mb-2 font-black">{card.title}</h4>
                <RichText text={card.body} className="text-sm" />
                {card.code && (
                  <div className="mt-3">
                    <CodeBlock code={card.code} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
