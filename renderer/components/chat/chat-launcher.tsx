'use client';

import * as React from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Opens the context-aware AI chat drawer for a video (and optionally one of its clips). Skeleton. */
export function ChatLauncher({ videoId, clipId }: { videoId: string; clipId?: string }) {
  return (
    <Button
      variant="outline"
      data-testid="chat-launcher"
      data-video-id={videoId}
      data-clip-id={clipId}
      disabled
    >
      <MessageSquare /> Ask AI
    </Button>
  );
}
