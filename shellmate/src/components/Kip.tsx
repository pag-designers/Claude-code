import { motion } from 'framer-motion';

export type KipMood = 'happy' | 'encourage' | 'thinking' | 'celebrate' | 'sad';

type Props = { mood?: KipMood; size?: number; className?: string };

// Kip — a hermit crab who lives in a tiny terminal window instead of a shell.
const SHELL = '#ff7a45';
const SHELL_DARK = '#c9542a';
const BODY = '#ff9f7d';
const BODY_DARK = '#d9623d';
const INK = '#1d2029';

const SCREEN: Record<KipMood, { text: string; color: string }> = {
  happy: { text: ':)', color: '#3ddc84' },
  encourage: { text: 'go!', color: '#3ddc84' },
  thinking: { text: '...', color: '#8cc8ff' },
  celebrate: { text: '★★', color: '#ffc83d' },
  sad: { text: 'x_x', color: '#ff5c6c' },
};

const PUPIL: Record<KipMood, [number, number]> = {
  happy: [1, 1],
  encourage: [1, 0],
  thinking: [2.5, -4],
  celebrate: [0, 0],
  sad: [0, 3.5],
};

function Claw({ x, y, angle, wave = false }: { x: number; y: number; angle: number; wave?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <motion.g
        initial={{ rotate: angle }}
        animate={wave ? { rotate: [angle, angle - 18, angle] } : { rotate: angle }}
        transition={wave ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' } : { type: 'spring', stiffness: 200 }}
        style={{ originX: '0px', originY: '0px' }}
      >
        <line x1="0" y1="0" x2="0" y2="-14" stroke={BODY_DARK} strokeWidth="8" strokeLinecap="round" />
        <line x1="0" y1="0" x2="0" y2="-14" stroke={BODY} strokeWidth="4.5" strokeLinecap="round" />
        <ellipse cx="-3" cy="-24" rx="7.5" ry="10.5" transform="rotate(-14 -3 -24)" fill={SHELL} stroke={SHELL_DARK} strokeWidth="2.2" />
        <ellipse cx="6.5" cy="-25" rx="3.6" ry="7.5" transform="rotate(22 6.5 -25)" fill={SHELL} stroke={SHELL_DARK} strokeWidth="2.2" />
      </motion.g>
    </g>
  );
}

function Eye({ cx, cy, mood, wink }: { cx: number; cy: number; mood: KipMood; wink?: boolean }) {
  const squint = mood === 'celebrate' || wink;
  if (squint) {
    return (
      <g>
        <circle cx={cx} cy={cy} r="10" fill="#fff" stroke={BODY_DARK} strokeWidth="2" />
        <path d={`M${cx - 5.5} ${cy + 2} Q${cx} ${cy - 6} ${cx + 5.5} ${cy + 2}`} stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" />
      </g>
    );
  }
  const [dx, dy] = PUPIL[mood];
  return (
    <g>
      <circle cx={cx} cy={cy} r="10" fill="#fff" stroke={BODY_DARK} strokeWidth="2" />
      <circle cx={cx + dx} cy={cy + dy} r="4.8" fill={INK} />
      <circle cx={cx + dx + 1.6} cy={cy + dy - 1.8} r="1.6" fill="#fff" />
      {mood === 'sad' && (
        // droopy eyelid
        <path d={`M${cx - 10.5} ${cy - 1} Q${cx} ${cy - 3} ${cx + 10.5} ${cy + 1} L${cx + 10.5} ${cy - 11} L${cx - 10.5} ${cy - 11} Z`} fill={BODY} stroke={BODY_DARK} strokeWidth="2" />
      )}
    </g>
  );
}

function Mouth({ mood }: { mood: KipMood }) {
  switch (mood) {
    case 'happy':
      return <path d="M49 91 Q55 98 61 91" stroke={INK} strokeWidth="2.8" fill="none" strokeLinecap="round" />;
    case 'encourage':
      return <path d="M48 90 Q55 99 62 90 Z" fill={INK} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />;
    case 'thinking':
      return <path d="M51 94 Q55 92 60 94" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />;
    case 'celebrate':
      return (
        <g>
          <path d="M46 89 Q55 103 64 89 Z" fill={INK} />
          <path d="M51 96 Q55 99 59 96" stroke="#ff5c6c" strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>
      );
    case 'sad':
      return <path d="M49 96 Q55 90 61 96" stroke={INK} strokeWidth="2.8" fill="none" strokeLinecap="round" />;
  }
}

function Sparkle({ x, y, delay, color }: { x: number; y: number; delay: number; color: string }) {
  return (
    <motion.path
      d={`M${x} ${y - 7} L${x + 2} ${y - 2} L${x + 7} ${y} L${x + 2} ${y + 2} L${x} ${y + 7} L${x - 2} ${y + 2} L${x - 7} ${y} L${x - 2} ${y - 2} Z`}
      fill={color}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{ opacity: [0, 1, 0], scale: [0.4, 1.15, 0.4] }}
      transition={{ duration: 1.2, repeat: Infinity, delay }}
      style={{ originX: `${x}px`, originY: `${y}px` }}
    />
  );
}

export default function Kip({ mood = 'happy', size = 120, className }: Props) {
  const screen = SCREEN[mood];
  const celebrate = mood === 'celebrate';
  const bob = celebrate
    ? { y: [0, -9, 0], transition: { duration: 0.55, repeat: Infinity, ease: 'easeOut' as const } }
    : { y: [0, -3, 0], transition: { duration: mood === 'sad' ? 3.2 : 2.4, repeat: Infinity, ease: 'easeInOut' as const } };

  const leftClaw = celebrate ? { x: 28, y: 84, angle: -25 } : mood === 'encourage' ? { x: 28, y: 86, angle: -15 } : mood === 'sad' ? { x: 28, y: 94, angle: -95 } : { x: 28, y: 90, angle: -55 };
  const rightClaw = celebrate ? { x: 82, y: 92, angle: 25 } : mood === 'sad' ? { x: 82, y: 100, angle: 100 } : { x: 82, y: 98, angle: 62 };

  return (
    <svg
      width={size}
      height={(size * 120) / 140}
      viewBox="0 0 140 120"
      className={className}
      role="img"
      aria-label={`Kip the hermit crab looks ${mood}`}
      style={{ overflow: 'visible' }}
    >
      {celebrate && (
        <g>
          <Sparkle x={10} y={22} delay={0} color="#ffc83d" />
          <Sparkle x={132} y={14} delay={0.4} color="#3ddc84" />
          <Sparkle x={134} y={96} delay={0.8} color="#4aa8ff" />
          <Sparkle x={4} y={70} delay={0.6} color="#ff5c6c" />
        </g>
      )}
      <ellipse cx="66" cy="114" rx="44" ry="5" fill="#000" opacity="0.18" />
      <motion.g animate={bob}>
        {/* legs */}
        {[38, 50, 66, 78].map((x, i) => (
          <path
            key={x}
            d={`M${x} 100 q${i < 2 ? -4 : 4} 7 ${i < 2 ? -8 : 8} 10`}
            stroke={BODY_DARK}
            strokeWidth="4.5"
            strokeLinecap="round"
            fill="none"
          />
        ))}

        {/* terminal shell */}
        <g transform="rotate(-6 93 55)">
          <rect x="58" y="22" width="72" height="64" rx="16" fill={SHELL} stroke={SHELL_DARK} strokeWidth="3" />
          <path d="M66 82 Q93 92 122 80" stroke={SHELL_DARK} strokeWidth="2" fill="none" opacity="0.5" />
          <circle cx="70" cy="32" r="2.6" fill="#ffd9c7" />
          <circle cx="78" cy="32" r="2.6" fill="#ffd9c7" />
          <circle cx="86" cy="32" r="2.6" fill="#ffd9c7" />
          <rect x="66" y="39" width="56" height="36" rx="7" fill="#14171d" stroke={SHELL_DARK} strokeWidth="2" />
          <text x="72" y="62" fontFamily="JetBrains Mono, ui-monospace, monospace" fontSize="13" fontWeight="700">
            <tspan fill="#8b93a5">{'>'}</tspan>
            <tspan fill={screen.color} dx="4">
              {screen.text}
            </tspan>
            <tspan fill={screen.color} className="cursor-blink">
              _
            </tspan>
          </text>
        </g>

        {/* body */}
        <ellipse cx="55" cy="91" rx="30" ry="15" fill={BODY} stroke={BODY_DARK} strokeWidth="2.5" />

        {/* eye stalks */}
        <motion.g
          animate={mood === 'thinking' ? { rotate: [0, 3, 0] } : { rotate: 0 }}
          transition={{ duration: 2, repeat: mood === 'thinking' ? Infinity : 0 }}
          style={{ originX: '53px', originY: '80px' }}
        >
          <path d={`M47 82 L41 ${mood === 'sad' ? 52 : 46}`} stroke={BODY_DARK} strokeWidth="7" strokeLinecap="round" />
          <path d={`M47 82 L41 ${mood === 'sad' ? 52 : 46}`} stroke={BODY} strokeWidth="4" strokeLinecap="round" />
          <path d={`M60 81 L63 ${mood === 'sad' ? 50 : 44}`} stroke={BODY_DARK} strokeWidth="7" strokeLinecap="round" />
          <path d={`M60 81 L63 ${mood === 'sad' ? 50 : 44}`} stroke={BODY} strokeWidth="4" strokeLinecap="round" />
          <Eye cx={40} cy={mood === 'sad' ? 46 : 40} mood={mood} />
          <Eye cx={64} cy={mood === 'sad' ? 44 : 38} mood={mood} wink={mood === 'encourage'} />
        </motion.g>

        {/* cheeks + mouth */}
        {mood !== 'sad' && mood !== 'thinking' && (
          <g fill="#ff5c8a" opacity="0.45">
            <ellipse cx="40" cy="92" rx="5" ry="3" />
            <ellipse cx="70" cy="92" rx="5" ry="3" />
          </g>
        )}
        <Mouth mood={mood} />
        {mood === 'sad' && <path d="M35 56 q-3 5 0 7 q3 -2 0 -7Z" fill="#8cc8ff" />}

        {/* claws */}
        <Claw {...leftClaw} wave={mood === 'encourage'} />
        <Claw {...rightClaw} />
      </motion.g>
    </svg>
  );
}
