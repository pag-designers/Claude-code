import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 24, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, ...rest };
}

export const FlameIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path
      d="M12 2c1 3.5 5.5 6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.2 1-3.8 2.2-5 .2 1.7 1 2.8 2.1 3.3C10.3 8.5 11 5 12 2Z"
      fill="#ff7a45"
    />
    <path d="M12 12c.6 1.6 2.6 2.7 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-1.4.9-2.4 1.6-3 .1.7.4 1.1.8 1.3.1-1 .1-2 .2-3.1Z" fill="#ffc83d" />
  </svg>
);

export const HeartIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path
      d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.6 4.5c2.2 0 3.6 1.2 5.4 3.1 1.8-1.9 3.2-3.1 5.4-3.1 3.6 0 5.7 3.9 4.2 7.3C19.5 16.4 12 21 12 21Z"
      fill="#ff5c6c"
    />
    <path d="M7 7.5c-1.3.3-2.2 1.6-2 3" stroke="#fff" strokeOpacity=".6" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);

export const GemIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill="#ffc83d" />
    <path d="M2 9h20M12 21 8 9l4-6 4 6-4 12" stroke="#c99412" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
  </svg>
);

export const LockIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <rect x="5" y="11" width="14" height="10" rx="2.5" fill="currentColor" stroke="none" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

export const CheckIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const StarIcon = (p: IconProps) => (
  <svg {...base(p)} fill="currentColor">
    <path d="m12 2.5 2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6-4.9-4.6 6.6-.8L12 2.5Z" />
  </svg>
);

export const CrownIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8Z" fill="#ffc83d" stroke="#c99412" strokeWidth="1.4" strokeLinejoin="round" />
    <circle cx="12" cy="15" r="1.6" fill="#ff7a45" />
  </svg>
);

export const ChestIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="10" width="18" height="10" rx="2" fill="#b86b2b" />
    <path d="M3 10a9 5 0 0 1 18 0" fill="#d4873e" />
    <rect x="3" y="10" width="18" height="2.4" fill="#ffc83d" />
    <rect x="10.2" y="11" width="3.6" height="4.6" rx="1" fill="#ffc83d" stroke="#8a4f1c" strokeWidth=".8" />
  </svg>
);

export const BookIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" />
    <path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />
  </svg>
);

export const PathIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-8.5Z" fill="#ff7a45" />
    <path d="M2 12 12 3.5 22 12" stroke="#d4561f" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CardsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="7" y="3" width="13" height="16" rx="2.5" fill="#4aa8ff" transform="rotate(8 13 11)" />
    <rect x="4" y="5" width="13" height="16" rx="2.5" fill="#8cc8ff" stroke="#1f74c4" strokeWidth="1.2" />
    <path d="M8 11h5M8 14h3" stroke="#1f74c4" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const TerminalIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2" y="4" width="20" height="16" rx="3" fill="#20242d" stroke="#3ddc84" strokeWidth="1.6" />
    <path d="m6 10 3 2-3 2M11 15h5" stroke="#3ddc84" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TrophyIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 3h10v6a5 5 0 0 1-10 0V3Z" fill="#ffc83d" />
    <path d="M7 5H4a3 3 0 0 0 3 4M17 5h3a3 3 0 0 1-3 4" stroke="#c99412" strokeWidth="1.8" fill="none" />
    <path d="M10 14h4v3h-4zM7 20a5 3 0 0 1 10 0v1H7v-1Z" fill="#c99412" />
  </svg>
);

export const UserIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="4.5" fill="#b18cff" />
    <path d="M3.5 21a8.5 8 0 0 1 17 0" fill="#8a63e6" />
  </svg>
);

export const XIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const CopyIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
    <rect x="8" y="8" width="13" height="13" rx="2.5" />
    <path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8" />
  </svg>
);

export const InfinityIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
    <path d="M12 12c-2-3-3.5-4.5-5.5-4.5a4.5 4.5 0 0 0 0 9C8.5 16.5 10 15 12 12Zm0 0c2 3 3.5 4.5 5.5 4.5a4.5 4.5 0 0 0 0-9C15.5 7.5 14 9 12 12Z" />
  </svg>
);

export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
