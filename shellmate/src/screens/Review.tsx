import { CardsIcon } from '../components/Icons';
import Kip from '../components/Kip';
import { lessonIndex } from '../content';
import { renderInline } from '../components/RichText';
import { todayStr } from '../lib/date';
import { dueReviewIds, LEITNER_INTERVALS, useGame, type ReviewItem } from '../store/useGame';
import { useNav } from '../store/useNav';
import type { Exercise } from '../types';

const BOX_COLORS = ['#ff5c6c', '#ff7a45', '#ffc83d', '#4aa8ff', '#3ddc84'];

function promptOf(e: Exercise): string {
  switch (e.type) {
    case 'prompt-workshop':
      return e.scenario;
    case 'mission':
      return e.title;
    default:
      return e.prompt;
  }
}

function snippet(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function Review() {
  const deck = useGame((s) => s.reviewDeck);
  const play = useNav((s) => s.play);
  const due = dueReviewIds({ reviewDeck: deck }).length;
  const entries = Object.entries(deck) as [string, ReviewItem][];
  const counts = [1, 2, 3, 4, 5].map((b) => entries.filter(([, i]) => i.box === b).length);
  const max = Math.max(1, ...counts);
  const today = todayStr();

  const items = entries
    .map(([id, item]) => ({ id, item, exercise: lessonIndex.get(item.lessonId)?.lesson.exercises.find((e) => e.id === id) }))
    .filter((x) => x.exercise)
    .sort((a, b) => a.item.box - b.item.box || a.item.due.localeCompare(b.item.due));

  return (
    <div className="px-4 pt-5">
      <div className="flex items-center gap-4">
        <Kip mood={due > 0 ? 'encourage' : 'happy'} size={90} />
        <div>
          <h1 className="text-2xl font-black">Review</h1>
          <p className="font-semibold text-muted">
            Missed answers come back here. Answer right to move them up a box — clear box 5 to retire them.
          </p>
        </div>
      </div>

      <div className="card mt-5">
        <div className="flex items-end justify-between gap-2" style={{ height: 120 }}>
          {counts.map((c, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1 self-stretch">
              <span className="text-sm font-black">{c}</span>
              <div
                className="w-full rounded-t-xl"
                style={{ height: `${Math.max(6, (c / max) * 80)}px`, background: BOX_COLORS[i], borderBottom: `4px solid color-mix(in srgb, ${BOX_COLORS[i]} 70%, black)` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between gap-2 text-center text-[11px] font-extrabold uppercase text-muted">
          {LEITNER_INTERVALS.map((d, i) => (
            <div key={i} className="flex-1">
              Box {i + 1}
              <div className="normal-case opacity-80">{d === 0 ? 'today' : `${d}d`}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card mt-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-3xl font-black text-primary">{due}</div>
          <div className="text-sm font-bold text-muted">due today</div>
        </div>
        <button className="btn3d" disabled={due === 0} onClick={() => play({ mode: 'review' })}>
          <CardsIcon size={20} /> Start review
        </button>
      </div>

      <h2 className="mb-2 mt-6 text-lg font-black">Missed items</h2>
      {items.length === 0 ? (
        <div className="card text-center font-semibold text-muted">No missed items yet. Mistakes are how we learn — they'll show up here.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map(({ id, item, exercise }) => (
            <li key={id} className="card flex items-center gap-3 rounded-2xl p-3">
              <span
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm font-black text-[#10131a]"
                style={{ background: BOX_COLORS[item.box - 1] }}
                title={`Box ${item.box}`}
              >
                {item.box}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold">{renderInline(snippet(promptOf(exercise!)))}</div>
                <div className="text-xs font-semibold text-muted">
                  {lessonIndex.get(item.lessonId)?.lesson.title} · {item.due <= today ? 'due now' : `due ${item.due}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
