'use client';

import * as React from 'react';
import { ShieldAlert } from 'lucide-react';
import {
  TIKTOK_PRIVACY_LEVELS,
  type PostFields,
  type ReelsFields,
  type ShortsFields,
  type TiktokFields,
} from '@shared/publish';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  LIMITS,
  cleanToken,
  counterState,
  fieldCounters,
  issuesFor,
  localFieldIssues,
} from '@/lib/publish/model';
import { cn } from '@/lib/utils';
import { CounterText, FormField, TextArea, ToggleRow, TokenInput } from './fields';

export interface FieldIssueLike {
  field: string;
  message: string;
}

export interface PlatformFieldsProps {
  fields: PostFields;
  onChange: (f: PostFields) => void;
  /** Issues from `publish:validate` (the local limit checks are merged in here). */
  issues?: readonly FieldIssueLike[];
  idPrefix: string;
  disabled?: boolean;
  durationSec?: number | null;
  /** TikTok app has not passed the audit: only private posts are allowed. */
  tiktokUnaudited?: boolean;
  /**
   * YouTube "made for kids" is a mandatory declaration: when given, nothing is pre-selected until the user answers
   * (`value` null) and the answer is read from here instead of `fields.madeForKids`.
   */
  kids?: { value: boolean | null; onChange: (v: boolean) => void };
  /** Several clips at once: text fields come from each clip's own metadata, so only the shared settings show. */
  sharedOnly?: boolean;
}

const CATEGORIES: [string, string][] = [
  ['22', 'People & Blogs'],
  ['24', 'Entertainment'],
  ['23', 'Comedy'],
  ['27', 'Education'],
  ['28', 'Science & Technology'],
  ['20', 'Gaming'],
  ['17', 'Sports'],
  ['10', 'Music'],
  ['25', 'News & Politics'],
  ['26', 'Howto & Style'],
  ['19', 'Travel & Events'],
  ['15', 'Pets & Animals'],
  ['2', 'Autos & Vehicles'],
  ['1', 'Film & Animation'],
  ['29', 'Nonprofits & Activism'],
];

export const PRIVACY_LABEL: Record<(typeof TIKTOK_PRIVACY_LEVELS)[number], string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual followers)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me (private)',
};

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h4 className="mt-1 text-2xs font-semibold uppercase tracking-wider text-subtle">{children}</h4>
);

/** Seconds <-> ms number box ("" = unset). */
function SecondsInput({
  id,
  valueMs,
  onChange,
  max,
  placeholder,
  label,
}: {
  id: string;
  valueMs: number | null;
  onChange: (ms: number | null) => void;
  max?: number | null;
  placeholder: string;
  label: string;
}) {
  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      min={0}
      max={max ? Math.floor(max) : undefined}
      step={0.5}
      aria-label={label}
      placeholder={placeholder}
      value={valueMs === null ? '' : String(valueMs / 1000)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(null);
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) onChange(Math.round(n * 1000));
      }}
      className="w-40 tabular-nums"
    />
  );
}

/* ------------------------------------------------------------------------------------ shorts ----- */

function ShortsEditor({
  f,
  set,
  issues,
  id,
  kids,
  sharedOnly,
}: {
  f: ShortsFields;
  set: (n: ShortsFields) => void;
  issues: readonly FieldIssueLike[];
  id: string;
  kids: PlatformFieldsProps['kids'];
  sharedOnly?: boolean;
}) {
  const c = fieldCounters(f);
  const kidsValue = kids ? kids.value : f.madeForKids;
  const setKids = (v: boolean) => {
    set({ ...f, madeForKids: v });
    kids?.onChange(v);
  };
  return (
    <>
      {sharedOnly ? null : (
        <>
          <FormField
            id={`${id}-title`}
            label="Title"
            required
            counter={c.title}
            error={issuesFor('title', issues)}
          >
            <Input
              id={`${id}-title`}
              value={f.title}
              invalid={counterState(c.title!) === 'over' || !!issuesFor('title', issues)}
              onChange={(e) => set({ ...f, title: e.target.value })}
              placeholder="Add a title that makes people stop scrolling"
            />
          </FormField>
          <FormField
            id={`${id}-description`}
            label="Description"
            counter={c.description}
            error={issuesFor('description', issues)}
            hint={
              f.addShortsTag
                ? 'Clipfern adds #Shorts to the description if it is missing.'
                : undefined
            }
          >
            <TextArea
              id={`${id}-description`}
              rows={4}
              value={f.description}
              invalid={counterState(c.description!) === 'over'}
              onChange={(e) => set({ ...f, description: e.target.value })}
            />
          </FormField>
          <FormField
            id={`${id}-tags`}
            label="Tags"
            counter={c.tags}
            error={issuesFor('tags', issues)}
            hint="Press Enter or comma to add a tag. YouTube counts all tags together (500 characters)."
          >
            <TokenInput
              id={`${id}-tags`}
              label="Add a tag"
              prefix="#"
              value={f.tags}
              max={LIMITS.shorts.tags}
              normalize={(t) => cleanToken(t, /^#+/)}
              onChange={(tags) => set({ ...f, tags })}
              invalid={counterState(c.tags!) === 'over'}
              placeholder="Add tags"
            />
          </FormField>
        </>
      )}

      <Heading>Audience</Heading>
      <fieldset
        className="flex flex-col gap-2"
        data-testid="kids-declaration"
        aria-describedby={`${id}-kids-hint`}
      >
        <legend className="text-sm font-medium">
          Is this video made for kids?<span className="ml-0.5 text-danger" aria-hidden>*</span>
        </legend>
        <p id={`${id}-kids-hint`} className="text-xs text-muted-foreground">
          YouTube requires this answer for every upload (COPPA). Kids&apos; videos get limited
          features such as comments.
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          {(
            [
              [false, 'No, it is not made for kids'],
              [true, 'Yes, it is made for kids'],
            ] as const
          ).map(([v, label]) => (
            <label
              key={String(v)}
              className={cn(
                'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-3 text-sm transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/25',
                kidsValue === v
                  ? 'border-primary/70 bg-primary-soft text-foreground'
                  : 'border-border-strong text-muted-foreground hover:bg-accent',
              )}
            >
              <input
                type="radio"
                name={`${id}-kids`}
                className="size-4 accent-[var(--primary)]"
                checked={kidsValue === v}
                onChange={() => setKids(v)}
                data-testid={v ? 'kids-yes' : 'kids-no'}
              />
              {label}
            </label>
          ))}
        </div>
        {kidsValue === null ? (
          <p className="text-xs text-warning" data-testid="kids-required">
            Choose one to continue.
          </p>
        ) : null}
      </fieldset>

      <Heading>Publishing</Heading>
      <FormField id={`${id}-visibility`} label="Visibility">
        <Segmented
          label="Visibility"
          value={f.visibility}
          onValueChange={(visibility) => set({ ...f, visibility })}
          options={[
            { value: 'public', label: 'Public' },
            { value: 'unlisted', label: 'Unlisted' },
            { value: 'private', label: 'Private' },
          ]}
        />
      </FormField>
      <FormField id={`${id}-category`} label="Category">
        <Select value={f.categoryId} onValueChange={(categoryId) => set({ ...f, categoryId })}>
          <SelectTrigger id={`${id}-category`} aria-label="Category" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map(([cid, name]) => (
              <SelectItem key={cid} value={cid}>
                {name}
              </SelectItem>
            ))}
            {CATEGORIES.some(([cid]) => cid === f.categoryId) ? null : (
              <SelectItem value={f.categoryId}>Category {f.categoryId}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </FormField>
      <ToggleRow
        id={`${id}-notify`}
        label="Notify subscribers"
        description="Sends the upload notification to people subscribed to your channel."
        checked={f.notifySubscribers}
        onCheckedChange={(notifySubscribers) => set({ ...f, notifySubscribers })}
      />
      <ToggleRow
        id={`${id}-shortstag`}
        label="Add #Shorts"
        description="Helps YouTube classify the video as a Short."
        checked={f.addShortsTag}
        onCheckedChange={(addShortsTag) => set({ ...f, addShortsTag })}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------- reels ----- */

function ReelsEditor({
  f,
  set,
  issues,
  id,
  durationSec,
  sharedOnly,
}: {
  f: ReelsFields;
  set: (n: ReelsFields) => void;
  issues: readonly FieldIssueLike[];
  id: string;
  durationSec?: number | null;
  sharedOnly?: boolean;
}) {
  const c = fieldCounters(f);
  const caption = c.caption!;
  return (
    <>
      {sharedOnly ? null : (
        <>
          <FormField
            id={`${id}-caption`}
            label="Caption"
            counter={caption}
            error={issuesFor('caption', issues)}
          >
            <TextArea
              id={`${id}-caption`}
              rows={6}
              value={f.caption}
              invalid={counterState(caption) === 'over'}
              onChange={(e) => set({ ...f, caption: e.target.value })}
              placeholder="Write a caption…"
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="reels-counters">
              <span className="inline-flex items-center gap-1.5 text-2xs text-subtle">
                Hashtags <CounterText counter={c.hashtags!} />
              </span>
              <span className="inline-flex items-center gap-1.5 text-2xs text-subtle">
                Mentions <CounterText counter={c.mentions!} />
              </span>
            </div>
          </FormField>
          <FormField
            id={`${id}-firstcomment`}
            label="First comment"
            counter={c.firstComment}
            error={issuesFor('firstComment', issues)}
            hint="Posted right after publishing. Many creators keep hashtags here."
          >
            <TextArea
              id={`${id}-firstcomment`}
              rows={2}
              value={f.firstComment ?? ''}
              onChange={(e) => set({ ...f, firstComment: e.target.value || null })}
              placeholder="Optional"
            />
          </FormField>
        </>
      )}
      <Heading>Publishing</Heading>
      <ToggleRow
        id={`${id}-feed`}
        label="Also share to the feed"
        description="Shows the Reel on your profile grid as well as in the Reels tab."
        checked={f.shareToFeed}
        onCheckedChange={(shareToFeed) => set({ ...f, shareToFeed })}
      />
      {sharedOnly ? null : (
        <>
          <FormField
            id={`${id}-cover`}
            label="Cover frame"
            hint="Seconds into the video. Leave empty to let Instagram choose."
            error={issuesFor('coverOffsetMs', issues)}
          >
            <SecondsInput
              id={`${id}-cover`}
              label="Cover frame in seconds"
              valueMs={f.coverOffsetMs}
              max={durationSec}
              placeholder="Auto"
              onChange={(coverOffsetMs) => set({ ...f, coverOffsetMs })}
            />
          </FormField>
          <FormField
            id={`${id}-collab`}
            label="Collaborators"
            hint="Up to 3 Instagram usernames, without the @."
            error={issuesFor('collaborators', issues)}
          >
            <TokenInput
              id={`${id}-collab`}
              label="Add a collaborator"
              prefix="@"
              max={LIMITS.reels.collaborators}
              value={f.collaborators}
              normalize={(t) => cleanToken(t, /^@+/)}
              onChange={(collaborators) => set({ ...f, collaborators })}
              placeholder="username"
            />
          </FormField>
          <FormField
            id={`${id}-location`}
            label="Location"
            hint="A Facebook Page id for the place, optional."
            error={issuesFor('locationId', issues)}
          >
            <Input
              id={`${id}-location`}
              value={f.locationId ?? ''}
              onChange={(e) => set({ ...f, locationId: e.target.value.trim() || null })}
              placeholder="Location id"
              className="w-64"
            />
          </FormField>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------ tiktok ----- */

function TiktokEditor({
  f,
  set,
  issues,
  id,
  unaudited,
  sharedOnly,
  durationSec,
}: {
  f: TiktokFields;
  set: (n: TiktokFields) => void;
  issues: readonly FieldIssueLike[];
  id: string;
  unaudited?: boolean;
  sharedOnly?: boolean;
  durationSec?: number | null;
}) {
  const c = fieldCounters(f);
  const draft = f.mode === 'draft';
  const branded = f.commercial.enabled && f.commercial.brandedContent;
  return (
    <>
      {sharedOnly ? null : (
        <FormField
          id={`${id}-title`}
          label="Caption"
          counter={c.title}
          error={issuesFor('title', issues)}
        >
          <TextArea
            id={`${id}-title`}
            rows={5}
            value={f.title}
            invalid={counterState(c.title!) === 'over'}
            onChange={(e) => set({ ...f, title: e.target.value })}
            placeholder="Write a caption with #hashtags…"
          />
        </FormField>
      )}

      <Heading>How to post</Heading>
      <FormField id={`${id}-mode`} label="Post as">
        <Segmented<TiktokFields['mode']>
          label="TikTok post mode"
          value={f.mode}
          onValueChange={(mode) =>
            set({ ...f, mode, privacyLevel: mode === 'draft' ? 'SELF_ONLY' : f.privacyLevel })
          }
          options={[
            { value: 'direct', label: 'Post directly' },
            { value: 'draft', label: 'Upload to drafts' },
          ]}
        />
        <p className="text-xs text-muted-foreground" data-testid="tiktok-mode-hint">
          {draft
            ? 'The video lands in your TikTok inbox. You open the TikTok app and publish it yourself.'
            : unaudited
              ? 'Direct posts from an unaudited app are private (only you can see them).'
              : 'Clipfern publishes it for you at the scheduled time.'}
        </p>
      </FormField>

      {draft ? null : (
        <FormField id={`${id}-privacy`} label="Who can watch this video">
          <Select
            value={unaudited ? 'SELF_ONLY' : f.privacyLevel}
            onValueChange={(v) => set({ ...f, privacyLevel: v as TiktokFields['privacyLevel'] })}
          >
            <SelectTrigger id={`${id}-privacy`} aria-label="Who can watch this video" className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIKTOK_PRIVACY_LEVELS.map((p) => (
                <SelectItem
                  key={p}
                  value={p}
                  disabled={(unaudited && p !== 'SELF_ONLY') || (branded && p === 'SELF_ONLY')}
                >
                  {PRIVACY_LABEL[p]}
                  {unaudited && p !== 'SELF_ONLY' ? ' · after audit' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {unaudited ? (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <ShieldAlert className="size-3.5 shrink-0" aria-hidden /> Locked to private until
              TikTok approves your app.
            </p>
          ) : branded ? (
            <p className="text-xs text-muted-foreground">
              TikTok does not allow branded content to be private.
            </p>
          ) : null}
        </FormField>
      )}

      <Heading>Interactions</Heading>
      <ToggleRow
        id={`${id}-comment`}
        label="Allow comments"
        checked={f.allowComment}
        onCheckedChange={(allowComment) => set({ ...f, allowComment })}
      />
      <ToggleRow
        id={`${id}-duet`}
        label="Allow Duet"
        checked={f.allowDuet}
        onCheckedChange={(allowDuet) => set({ ...f, allowDuet })}
      />
      <ToggleRow
        id={`${id}-stitch`}
        label="Allow Stitch"
        checked={f.allowStitch}
        onCheckedChange={(allowStitch) => set({ ...f, allowStitch })}
      />

      <Heading>Disclosure</Heading>
      <ToggleRow
        id={`${id}-commercial`}
        label="This video promotes a brand or product"
        description="TikTok requires you to disclose commercial content."
        checked={f.commercial.enabled}
        onCheckedChange={(enabled) => set({ ...f, commercial: { ...f.commercial, enabled } })}
      />
      {f.commercial.enabled ? (
        <div className="ml-1 flex flex-col gap-2.5 rounded-lg border bg-muted/30 p-3">
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox
              checked={f.commercial.yourBrand}
              aria-label="Your own brand"
              onCheckedChange={(yourBrand) =>
                set({ ...f, commercial: { ...f.commercial, yourBrand } })
              }
            />
            Your own brand
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox
              checked={f.commercial.brandedContent}
              aria-label="Branded content for a third party"
              onCheckedChange={(brandedContent) =>
                set({
                  ...f,
                  commercial: { ...f.commercial, brandedContent },
                  // TikTok does not allow private branded content
                  privacyLevel:
                    brandedContent && !unaudited && f.privacyLevel === 'SELF_ONLY'
                      ? 'PUBLIC_TO_EVERYONE'
                      : f.privacyLevel,
                })
              }
            />
            Branded content (a third party pays you)
          </label>
        </div>
      ) : null}
      <ToggleRow
        id={`${id}-aigc`}
        label="AI-generated content"
        description="Adds TikTok's AI-generated label."
        checked={f.aigc}
        onCheckedChange={(aigc) => set({ ...f, aigc })}
      />
      {sharedOnly ? null : (
        <FormField
          id={`${id}-cover`}
          label="Cover frame"
          hint="Seconds into the video. Leave empty to let TikTok choose."
          error={issuesFor('coverTimestampMs', issues)}
        >
          <SecondsInput
            id={`${id}-cover`}
            label="Cover frame in seconds"
            valueMs={f.coverTimestampMs}
            max={durationSec}
            placeholder="Auto"
            onChange={(coverTimestampMs) => set({ ...f, coverTimestampMs })}
          />
        </FormField>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------- entry ----- */

/** The platform-specific form for one post (YouTube Shorts, Instagram Reels or TikTok). */
export function PlatformFields(p: PlatformFieldsProps) {
  const { fields, onChange, idPrefix } = p;
  const issues = React.useMemo(
    () => [...(p.issues ?? []), ...localFieldIssues(fields)],
    [p.issues, fields],
  );
  return (
    <fieldset
      disabled={p.disabled}
      className="flex min-w-0 flex-col gap-4 border-0 p-0 disabled:opacity-70"
      data-testid={`fields-${fields.platform}`}
    >
      {fields.platform === 'shorts' ? (
        <ShortsEditor
          f={fields}
          set={onChange}
          issues={issues}
          id={idPrefix}
          kids={p.kids}
          sharedOnly={p.sharedOnly}
        />
      ) : fields.platform === 'reels' ? (
        <ReelsEditor
          f={fields}
          set={onChange}
          issues={issues}
          id={idPrefix}
          durationSec={p.durationSec}
          sharedOnly={p.sharedOnly}
        />
      ) : (
        <TiktokEditor
          f={fields}
          set={onChange}
          issues={issues}
          id={idPrefix}
          unaudited={p.tiktokUnaudited}
          durationSec={p.durationSec}
          sharedOnly={p.sharedOnly}
        />
      )}
    </fieldset>
  );
}
