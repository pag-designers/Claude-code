/** Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /live/ (and m./music./www. hosts). */
export type YoutubeParse =
  | { ok: true; id: string; kind: 'watch' | 'short-link' | 'shorts' | 'live' }
  | { ok: false; reason: string };

const ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYoutubeUrl(input: string): YoutubeParse {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: 'Enter a full link, e.g. https://www.youtube.com/watch?v=…' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http(s) links are supported.' };
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return ID.test(id)
      ? { ok: true, id, kind: 'short-link' }
      : { ok: false, reason: 'That youtu.be link is missing a valid video ID.' };
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') {
      const id = url.searchParams.get('v') ?? '';
      return ID.test(id)
        ? { ok: true, id, kind: 'watch' }
        : { ok: false, reason: 'This watch link is missing a valid ?v= video ID.' };
    }
    if (parts[0] === 'shorts' || parts[0] === 'live') {
      const id = parts[1] ?? '';
      return ID.test(id)
        ? { ok: true, id, kind: parts[0] }
        : { ok: false, reason: `This /${parts[0]}/ link is missing a valid video ID.` };
    }
    return {
      ok: false,
      reason:
        'Use a video link: youtube.com/watch?v=…, /shorts/…, or /live/… (channels and playlists are not supported yet).',
    };
  }
  return {
    ok: false,
    reason:
      'That is not a YouTube link. Try youtube.com/watch?v=…, youtu.be/…, /shorts/… or /live/….',
  };
}
