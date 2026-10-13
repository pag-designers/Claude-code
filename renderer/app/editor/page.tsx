import Link from 'next/link';
import {
  AudioLines,
  Captions,
  Clapperboard,
  Keyboard,
  Layers,
  Library,
  Move3d,
  Type,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

const CAPABILITIES = [
  {
    icon: Layers,
    title: 'Multi-track timeline',
    text: 'Video, overlay, text, subtitle and audio tracks with snapping and ripple edits.',
  },
  {
    icon: Move3d,
    title: 'Keyframes and reframe',
    text: 'Position, scale and crop with easing curves, plus the AI face-tracking path.',
  },
  {
    icon: Captions,
    title: 'Subtitle editor',
    text: 'Edit words inline, retime by dragging, restyle per line.',
  },
  { icon: Type, title: 'Text and stickers', text: 'Brand-kit text styles with in/out animations.' },
  {
    icon: AudioLines,
    title: 'Music and ducking',
    text: 'Auto-duck music under speech and snap cuts to the beat.',
  },
  {
    icon: Keyboard,
    title: 'CapCut-style shortcuts',
    text: 'J/K/L transport, S to split, frame stepping, 200-level undo.',
  },
];

export default function EditorPage() {
  return (
    <div className="flex min-h-full flex-col">
      <EmptyState
        size="lg"
        icon={Clapperboard}
        title="The editor opens from your Library"
        description="Pick any clip or video in the Library and choose Open in editor. It loads with the transcript, moments and captions already in place. The full editor arrives in checkpoint 3."
        actions={
          <Button variant="primary" asChild>
            <Link href="/library/">
              <Library /> Go to Library
            </Link>
          </Button>
        }
        className="min-h-[360px] flex-1"
      />
      <section
        aria-label="What the editor will include"
        className="mx-auto w-full max-w-[1100px] px-8 pb-12"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <h2 className="font-display text-lg font-semibold">What you&apos;ll get</h2>
          <Badge variant="primary">Checkpoint 3</Badge>
        </div>
        <ul className="grid grid-cols-3 gap-3 max-[1180px]:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <li key={c.title} className="flex gap-3 rounded-xl border bg-card p-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <c.icon className="size-4" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold">{c.title}</p>
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{c.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
