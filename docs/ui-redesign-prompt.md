# Clipper UI redesign: the prompt

**How to use:** paste everything between the two `=====` lines to Claude in a Clipper session. It rebuilds the
front end (`frontend/index.html`, `style.css`, `app.js`) to this spec. Change the numbers or wording below first
if you want a different look. Below the prompt is the measurement table the spec came from.

=====

You are redesigning the front end of **Clipper** (my local AI clipping app) so it looks and feels like a modern
dark AI-video-tool site. Visual reference: the layout system of the public page wayin.ai/tools/clip-maker (dark
canvas, one green accent, pill controls, big rounded cards, alternating media/text sections, FAQ accordion,
sticky floating CTA). Reproduce the *design language and page structure*, not their code or content.

## Hard rules
1. **Original work only.** Write all HTML/CSS/JS yourself. Do not copy the reference's code, copy, images, logo,
   icons or brand name. The product is called **Clipper**; use my own logo mark and my own wording and
   illustrations (built from CSS/SVG). Never call the reference site's API.
2. **Keep the app working.** Keep every existing element id / data-attribute used by `app.js` and the
   Playwright checks (`#urlForm #urlInput #uploadBtn #fileInput #keyBadge #settings #sKey #sModel #sEffort #sSave
   #campaignSelect #campParse #campBrief #campName #campList #videoList .vitem .card .thumb #clips #selectAll
   #checkCamp [data-edit] [data-pick] #bulkBar #bulkVariants #bulkExport #drawer #drawerClose #eWords .w
   #renderPreview #pvBusy #eVariants .variant .copy [data-tab] #transcript .sent #makeClip #openFolder #toast`).
   Same API calls, same behaviour (autosave, shortcuts, polling, chime).
3. **No build step, no CDN.** Plain HTML/CSS/JS served by FastAPI. Fonts come from `assets/fonts` (served at
   `/fonts/`). Works offline.
4. **Accessible and responsive.** WCAG AA contrast, visible focus rings, `prefers-reduced-motion` respected,
   usable at 390px, no horizontal scroll, touch targets ≥ 40px.

## Design tokens
| Token | Value |
|---|---|
| Canvas | `#090A0A` |
| Surface (cards) | `#151617`; raised `#1D1E1F`; hover `#242627`; row tint `rgba(255,255,255,.05)` |
| Brand green | `#1ED760`; gradient `#1ED760 → #7DF76B` (buttons); button text `#052E16` |
| Icon gradient | `#22D3EE → #C6F432` (cyan → lime), used on feature icons and score numbers |
| Text | title `#fff`; body `rgba(255,255,255,.70)`; support `.50`; disabled `.30` |
| Danger / warn | `#FB4A4A` / `#FFB020` |
| Font | Poppins 400 / 500 / 600 / 700 |
| Radii | pill `9999px`; card `24px`; row `16px`; big panel `100px` (desktop) → `20px` (mobile) |
| Layout | content max-width `1200px`; section padding `64px 72px` desktop, `48px 16px` mobile; page max `1440px` |

Type scale: H1 line 1 (green) `clamp(40px, 6.1vw, 88px)` / 1.1 / 700; H1 line 2 (white) `clamp(30px, 4.4vw, 64px)` / 700;
section title 32px / 600 (24px mobile); feature title 20px / 500; lead 18px / 1.5 at body alpha;
caption 12px at support alpha; nav 16px.

## Page structure (home)
1. **Fixed nav**, 72px, transparent on the canvas, gains blur + hairline border after scrolling 8px. Logo left;
   links (Clip maker, Your videos, Campaigns, How it works, FAQ) centred; right side holds the campaign picker
   and the settings badge. Under 900px the links collapse into a hamburger panel.
2. **Hero**, centred: H1 in two lines (green, then white), lead paragraph (max 960px), then the **input pill**:
   56px high, 2px green border, link icon, text input, round gradient arrow button inside; beside it a small "or"
   and an outlined **Upload** pill; a 12px caption under it. Drag-and-drop a file anywhere on the hero.
3. **Demo card**: 1200px wide, radius 32px, soft radial glow, containing a CSS-drawn mock: a player frame, an input
   pill that "types", and a row of five clip thumbnails (mix of 16:9 and 9:16) with platform badges and lime
   score numbers (99, 97, 95, 91, 89). Animation on a pause/play round button bottom right.
4. **Your videos strip** (only when videos exist): horizontal row of video cards with status badge.
5. **Marquee** of "built for" pills (TikTok, YouTube Shorts, Instagram Reels, X, Whop campaigns, podcasts,
   interviews, streams), infinite slow scroll, edges fade out.
6. **Six alternating media/text sections** (text 24-26px/600 title, 18px body at body alpha, ghost-pill CTA with
   arrow; media is a rounded mock card). Topics: find the best moments + edit by deleting words; viral score
   ranking; campaign requirements checker; vertical reframe/layouts; animated captions; three variants.
7. **Feature grid**: 3 x 3 cards, radius 24, `#151617`, gradient line icon top-left, 20px/500 title, 15px body.
8. **Big rounded panel** (`#1D1E1F`, radius 100px desktop): campaign rules as check chips + CTA.
9. **Campaign setup** (functional): paste a brief, save, list saved campaigns.
10. **How it works**: three numbered steps.
11. **FAQ**: rows with `rgba(255,255,255,.05)` background, radius 16, chevron rotating on open, "Expand all".
12. **Closing CTA** + **footer** (canvas colour, 4 columns on desktop, stacked on mobile).
13. **Sticky floating CTA** "Create clips" gradient pill (arrow in a white circle), bottom-centre, appears after the
    hero scrolls out of view; click scrolls to the input and focuses it.

## Workspace pages (video, editor, settings): same system
- Breadcrumb `Home > Videos > <title>` (13px, current page in green), H1 title 40px/700.
- **Segmented pill controls** instead of dropdowns for tabs and sorting ("Virality · highest first", "Time ·
  earliest first", "Meets rules").
- **Clip cards**: `#151617`, radius 20, 16:9 thumbnail on top with lime score chip bottom-left (`96` big, `/100`
  small), duration chip bottom-right, select checkbox top-left; below: title, tags, hook line, six slim score bars,
  verdict, actions (ghost-pill Edit).
- **Buttons**: primary = gradient pill; ghost = `1px rgba(30,215,96,.35)` border, `rgba(30,215,96,.10)` fill, green
  text; soft = white/8 fill; outline = 2px green border. 0.2s transitions, hover brightens, active presses 1px.
- Bulk bar = floating glass pill. Editor = right drawer on `#121313`. Modals radius 28.

## PRIORITY: the logged-in workspace (observed from a screenshot of the real results page)
The user's logged-in results page ("All Moments") matters more than the marketing page. Rebuild Clipper's app shell
and video page to this layout. (Source: one screenshot, 1500px wide; exact colours are estimated by eye.)

- **Top bar** (~72px): logo + wordmark in brand green on the left; on the video page a back arrow and the (truncated)
  video title next to it; right side holds utility links and a pill CTA, a bell and a round green avatar.
  *Clipper version:* logo, back arrow + title on the video page, campaign picker, settings badge.
- **Left icon sidebar** (~80px wide, a rounded raised panel inset from the screen edge): icon above a 11px label,
  one item per section (Home, Library, Scheduler, Brand Kit, Pricing, Rewards, API). Active item tinted green.
  *Clipper version:* Home, Library, Campaigns, Guide, Settings.
- **Results header row:** title "All Moments" (16-18px, 600) left; right: a square filter button and a pill select
  "Sort by Highest Viral Score" with chevron.
- **Bulk-action bar** directly under it: full-width rounded (24px) container, subtle border, icon + "Select clips to
  enable bulk actions" on the left, pill buttons on the right (Bulk Edit, Bulk Schedule, Bulk Export, divider, Create
  Montage), all disabled and dimmed until clips are ticked. *Clipper version:* Versions select, Bulk export, divider,
  Check campaign rules.
- **Tabs:** active tab "Viral Moments" with a count chip, drawn as a raised rounded tab; next to it "+ Find Moments".
- **Panel** under the tabs (rounded 24px, slightly lighter than the page, hairline border): first row is a checkbox
  "Select all 5 clips", then a **3-column card grid**.
- **Clip card:** 20px radius, near-black fill, 1px dark-green border. Header row: checkbox, "#1 title..." (one line,
  ellipsis), small icon button on the right. Thumbnail 16:9 edge to edge with a big round translucent play button in
  the middle, a dark time-range chip top-right ("03:56 - 05:32"), a yellow "Edited" chip next to it when the clip was
  modified. Below: score "80" large in brand green with a small grey "/100", then a row of six round icon buttons
  (publish, trim, reframe, download, share, more). Then a two-line description in near-white 14px.
- **Page background** is a very dark green-black (not neutral grey), panels one step lighter.

## ALSO: the workspace Home (observed from a screenshot of a second tool's logged-in dashboard)
Layout patterns only (no copying of their code, copy, logo or imagery). Home is a *workspace*, not a landing page:
- Centred question as title ("What do you want to clip today?"), then one wide rounded input bar (radius 22px, raised
  fill, link icon, placeholder "Drop a YouTube or video link") with a solid action button inside on the right
  ("Get clips in 1 click").
- Under it two soft pill buttons: **Upload**, **Add campaign rules**. Then a wrapped row of outlined **tool pills**
  with a small icon each (Long to shorts, Edit by text, Captions, Auto reframe, Find moments, 3 variants, Rules check,
  Platform captions).
- **Recent projects** row (title + "View all >"): video cards with a 16:9 thumbnail, a progress chip
  ("34%") while processing or a status chip when done, two-line title, duration.
- **What's inside** row: four tall gradient cards, each with a tag chip top-right, a bold title and one line of text.
- Top right: campaign picker + AI/key badge + "New video". The marketing page (animated demo card, marquee, alternating
  media/text rows, feature grid, FAQ, closing CTA, sticky "Create clips" button) lives on the **Guide** page.
- Sidebar: Home, Library, Campaigns, Guide, Settings. On phones it becomes a bottom tab bar.

## Motion
Section reveal (fade + 16px rise, once), card hover lift 2px + glow, marquee, demo float, chevron rotation. All
disabled under `prefers-reduced-motion`.

## Acceptance
Screenshot at 1440 and 390 and compare section by section to the structure above. Run the full Playwright flow
(upload, make clip, edit, preview, variants, export) with zero console errors. Run `/ship-check`. Update
`CLAUDE.md`. Commit and push.

=====

## Measurements the spec came from (public page, 1440px viewport)
| Item | Measured |
|---|---|
| Page height | 11.5k px desktop, 12.5k mobile; 17 top-level sections |
| Background | `rgb(9,10,10)`; dark panel `rgb(29,30,31)` |
| Brand | `#1ED760`; tints at 10 / 35 % alpha for ghost buttons |
| Text alphas | title 1.0, body 0.7, support 0.5, disabled 0.3 |
| Font | Poppins 400/500/600/700, body 16/24 |
| H1 | 88px / 96.8px / 700, centred; second line 64px |
| Section H2 | 32px / 600 (feature rows 24px / 500); card H3 20px / 500 |
| Lead paragraph | 18px / 27px, max-width 960px, alpha .7 |
| Header | fixed, 72px, transparent, `transition-all 300ms` |
| Input pill | 56px high, 2px brand border, radius 9999, 2px inner padding |
| Ghost CTA | 44px high, padding 9px 15px, 1px brand/35 border, brand/10 fill, radius 9999, 8px gap |
| Section padding | `48px 12px` mobile, `64px 72px` desktop |
| Card | 373px wide in a 3-col grid, 269px tall, radius ~24px |
| FAQ row | 67px high, radius 16px, `rgba(255,255,255,.05)`, 16px gap |
| Big panel | radius 100px desktop / 20px mobile |
| Animations present | marquee scroll, reveal (opacity + transform .5s), select slide, spinner, pulse |
| Layout blocks | breadcrumb, hero + input, demo card, logo marquee, 10 media/text rows, 9 benefit cards, dark panel, 3 steps, FAQ, CTA, footer, sticky CTA |
