'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useResolvedTheme } from '@/lib/prefs';

/** sonner themed with Clipfern tokens; stack bottom-right, clear of the Windows caption buttons. */
export function Toaster(props: ToasterProps) {
  const theme = useResolvedTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      gap={10}
      visibleToasts={4}
      closeButton
      icons={{
        success: <CircleCheck className="size-4 text-success" aria-hidden />,
        error: <CircleAlert className="size-4 text-danger" aria-hidden />,
        warning: <TriangleAlert className="size-4 text-warning" aria-hidden />,
        info: <Info className="size-4 text-info" aria-hidden />,
        loading: <LoaderCircle className="size-4 animate-spin text-primary-text" aria-hidden />,
      }}
      toastOptions={{
        classNames: {
          toast:
            '!rounded-xl !border !border-border-strong !bg-popover !text-foreground !shadow-lg !font-sans !text-sm !gap-3 !p-3.5',
          title: '!font-semibold !text-foreground',
          description: '!text-muted-foreground !text-xs',
          actionButton: '!bg-primary !text-primary-foreground !rounded-md !font-medium',
          cancelButton: '!bg-muted !text-foreground !rounded-md',
          closeButton: '!border-border-strong !bg-raised !text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}
