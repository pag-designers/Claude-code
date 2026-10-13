import { cn } from '@/lib/utils';

/** Clipfern mark: a fern frond cut by a clip line, on the brand gradient. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} aria-hidden>
      <defs>
        <linearGradient
          id="cf-logo-bg"
          x1="3"
          y1="2"
          x2="29"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#8a6bff" />
          <stop offset="1" stopColor="#5330e0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#cf-logo-bg)" />
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8.5"
        fill="none"
        stroke="#fff"
        strokeOpacity=".22"
      />
      <path d="M9 23c0-8 5.2-13.4 14-14 0 8.6-5.4 14-14 14Z" fill="#fff" />
      <path d="M9.5 22.5 19.5 12.5" stroke="#5a38e6" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M12.6 19.6h5M15.3 16.9h4.6"
        stroke="#5a38e6"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity=".55"
      />
    </svg>
  );
}
