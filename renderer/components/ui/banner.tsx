import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

const banner = cva('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', {
  variants: {
    tone: {
      info: 'border-info/30 bg-info-soft [&>svg]:text-info',
      success: 'border-success/30 bg-success-soft [&>svg]:text-success',
      warning: 'border-warning/35 bg-warning-soft [&>svg]:text-warning',
      danger: 'border-danger/35 bg-danger-soft [&>svg]:text-danger',
      neutral: 'border-border-strong bg-muted [&>svg]:text-muted-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

const ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
  neutral: Info,
};

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  className,
}: VariantProps<typeof banner> & {
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = ICONS[tone ?? 'info'];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn(banner({ tone }), className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-foreground">{title}</p> : null}
        {children ? (
          <div className={cn('text-muted-foreground', title && 'mt-0.5')}>{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
