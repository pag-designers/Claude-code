'use client';

import * as React from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tip } from '@/components/ui/tooltip';
import {
  registerSeeker,
  scopeKey,
  useChatHub,
  useChatUi,
  useLauncherOwner,
  type ChatScope,
} from '@/lib/cp2-chat';
import { useOptionalPlayer } from '@/lib/player';
import { ChatSheet } from './chat-sheet';

/**
 * Opens the context-aware AI chat for a video (or one of its clips). Mount it wherever the user is looking at a
 * video/clip: it owns the ⌘/Ctrl+J shortcut while it is the most recently mounted launcher (so an open clip drawer
 * wins over the page behind it), subscribes to the chat stream once, and lets chat timestamps seek the page's
 * source player when there is one.
 */
export function ChatLauncher({ videoId, clipId }: { videoId: string; clipId?: string }) {
  useChatHub();
  const owner = useLauncherOwner();
  const player = useOptionalPlayer();
  const scope = React.useMemo<ChatScope>(() => ({ videoId, clipId: clipId ?? null }), [videoId, clipId]);
  const key = scopeKey(scope);
  const open = useChatUi((s) => s.open);
  const activeKey = useChatUi((s) => (s.scope ? scopeKey(s.scope) : null));
  const openChat = useChatUi((s) => s.openChat);
  const closeChat = useChatUi((s) => s.closeChat);
  const mine = open && activeKey === key;

  const toggle = React.useCallback(() => {
    const st = useChatUi.getState();
    if (st.open && st.scope && scopeKey(st.scope) === key) closeChat();
    else openChat(scope);
  }, [key, scope, openChat, closeChat]);

  useHotkeys('mod+j', toggle, { enableOnFormTags: true, preventDefault: true, enabled: owner }, [toggle]);

  // the page's proxy player (only present on the video page) is a seek target for chat timestamps
  React.useEffect(() => {
    if (!player || clipId) return;
    return registerSeeker((vid, t) => {
      if (vid !== videoId) return false;
      // On the Clips tab the player is hidden: switch to a tab that shows it, so the seek is visible (and audible).
      const el = player.videoRef.current;
      if (el && el.offsetParent === null) {
        const url = new URL(window.location.href);
        if (url.searchParams.get('tab') === 'clips') {
          url.searchParams.set('tab', 'overview');
          window.history.replaceState(null, '', `${url.pathname}${url.search}`);
        }
      }
      return player.seek(t, { play: true });
    });
  }, [player, videoId, clipId]);

  // when this launcher goes away (e.g. the clip drawer closes) its panel goes with it
  React.useEffect(
    () => () => {
      const st = useChatUi.getState();
      if (st.open && st.scope && scopeKey(st.scope) === key) st.closeChat();
    },
    [key],
  );

  return (
    <>
      <Tip
        content={
          <span className="flex items-center gap-2">
            Ask AI about this {clipId ? 'clip' : 'video'} <Kbd keys={['mod', 'J']} />
          </span>
        }
      >
        <Button
          variant="outline"
          onClick={toggle}
          aria-pressed={mine}
          aria-keyshortcuts="Control+J Meta+J"
          data-testid={clipId ? 'chat-launcher-clip' : 'chat-launcher'}
          data-video-id={videoId}
          data-clip-id={clipId}
        >
          <MessageSquare /> Ask AI
        </Button>
      </Tip>
      {mine ? (
        <ChatSheet scope={scope} open onOpenChange={(o) => (o ? openChat(scope) : closeChat())} />
      ) : null}
    </>
  );
}
