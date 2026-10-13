// Clipper web UI: plain JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const mmssp = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const icon = (n, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const DIMS = ["hook", "story", "value", "engagement", "reach", "pacing"];
const STAGE = { queued: "Queued", download: "Downloading", audio: "Preparing", transcribe: "Transcribing", cues: "Analyzing",
  clipping: "Finding clips", scoring: "Scoring", ready: "Ready", needs_key: "Needs API key", error: "Failed" };
const LANG = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian" };
const LAYOUT = { auto: "Auto", track: "Follow face", split: "Split screen", speaker: "Active speaker", fit: "Fit whole frame" };
const PLATFORM = { tiktok: "TikTok", youtube_shorts: "Shorts", instagram_reels: "Reels", x: "X" };

const state = { config: null, campaigns: [], video: null, transcript: null, sort: "score", selected: new Set(),
  editing: null, dirty: false, sel: [null, null], poll: null, eta: null, exporting: false, io: null, io2: null };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}, ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, err = false, ms = 4500, html = false) {
  const t = $("#toast");
  t.className = "toast" + (err ? " err" : ""); t.setAttribute("role", err ? "alert" : "status");
  t.innerHTML = `<div class="toast-body"></div><button class="toast-x" aria-label="Dismiss">✕</button>`;
  html ? ($(".toast-body", t).innerHTML = msg) : ($(".toast-body", t).textContent = msg);
  $(".toast-x", t).onclick = () => t.classList.add("hidden");
  clearTimeout(toast._t); if (ms) toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function waitJob(job, onProgress) {
  for (;;) {
    const j = await api(`/api/jobs/${job.id}`);
    onProgress?.(j);
    if (j.status === "done") return j.result;
    if (j.status === "error") throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const scoreColor = (s) => (s >= 80 ? "var(--good)" : s >= 60 ? "var(--accent)" : s >= 45 ? "var(--warn)" : "var(--bad)");
const campaignSlug = () => $("#campaignSelect").value;
const isBusy = (s) => !!s && !["ready", "needs_key", "error"].includes(s);

// ---------------- "done" signals: chime, notification, tab title ----------------
const prefs = {
  get chime() { try { return localStorage.getItem("chime") !== "off"; } catch { return true; } },
  set chime(v) { try { localStorage.setItem("chime", v ? "on" : "off"); } catch {} },
};
function audioCtx() { return (audioCtx.ac ||= new (window.AudioContext || window.webkitAudioContext)()); }
function chime() {                          // soft two-note bell (~1 s), generated: no sound files
  if (!prefs.chime) return;
  try {
    const ac = audioCtx(); ac.resume?.();
    const t0 = ac.currentTime + 0.03, out = ac.createGain();
    out.gain.value = 0.16; out.connect(ac.destination);
    [[659.25, 0], [987.77, 0.13]].forEach(([f, dt]) => {   // E5 then B5
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + dt);
      g.gain.linearRampToValueAtTime(1, t0 + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.9);
      o.connect(g).connect(out); o.start(t0 + dt); o.stop(t0 + dt + 1);
    });
  } catch {}
}
// Browsers only allow sound after the user has interacted with the page once.
document.addEventListener("pointerdown", () => { try { audioCtx().resume(); } catch {} }, { once: true });
function askNotify() { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {}); }
function signalDone(title, body, ok = true) {
  if (ok) chime();
  if (!document.hidden) return;
  document.title = `${ok ? "✓" : "!"} ${title} · Clipper`;
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(`Clipper: ${title}`, { body, tag: "clipper" });
    n.onclick = () => { window.focus(); n.close(); };
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && /^[✓!]/.test(document.title)) document.title = state.video?.title ? `${state.video.title} · Clipper` : "Clipper";
});

// ---------------- boot & settings ----------------
function applyConfig(c) {
  state.config = c;
  const kb = $("#keyBadge");
  kb.textContent = c.has_api_key ? `AI: ${c.model.replace("claude-", "")}` : "AI off: add API key";
  kb.className = "badge " + (c.has_api_key ? "ok" : "bad");
}

const focusBack = {};
function remember(k) { const el = document.activeElement; focusBack[k] = { el, card: el?.closest?.(".card")?.dataset.id }; }
function restore(k) {   // cards are redrawn after an edit, so fall back to the same card's Edit button
  const f = focusBack[k]; focusBack[k] = null; if (!f) return;
  const el = f.el && document.contains(f.el) ? f.el : f.card && $(`.card[data-id="${f.card}"] [data-edit]`);
  el?.focus({ preventScroll: true });
}
function closeSettings() { $("#settings").classList.add("hidden"); restore("settings"); }
function trapTab(box, e) {
  if (e.key !== "Tab") return;
  const f = $$('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea,summary,[tabindex="0"]', box).filter((x) => x.offsetParent);
  if (!f.length) return;
  const a = f[0], z = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === a || !box.contains(document.activeElement))) { e.preventDefault(); z.focus(); }
  else if (!e.shiftKey && (document.activeElement === z || !box.contains(document.activeElement))) { e.preventDefault(); a.focus(); }
}
document.addEventListener("keydown", (e) => { for (const id of ["#settings", "#drawer"]) if (!$(id).classList.contains("hidden")) return trapTab($(id), e); });

function openSettings() {
  remember("settings");
  const c = state.config;
  $("#sModel").innerHTML = Object.entries(c.models).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  $("#sModel").value = c.model;
  $("#sEffort").innerHTML = c.efforts.map((e) => `<option>${e}</option>`).join("");
  $("#sEffort").value = c.effort;
  $("#sKey").value = "";
  $("#sKeyHint").textContent = c.has_api_key ? `Current key: ${c.key_hint} (leave empty to keep it)` : "No key saved yet.";
  $("#sMsg").textContent = "";
  $("#sChime").checked = prefs.chime;
  $("#sChime").onchange = (e) => { prefs.chime = e.target.checked; if (e.target.checked) chime(); };
  const canN = "Notification" in window;
  $("#sNotify").checked = canN && Notification.permission === "granted";
  $("#sNotify").disabled = !canN || Notification.permission === "denied";
  $("#sNotify").onchange = (e) => { if (e.target.checked) Notification.requestPermission().then((p) => (e.target.checked = p === "granted")); };
  $("#settings").classList.remove("hidden");
  setTimeout(() => $("#sKey").focus(), 50);
}

async function saveSettings() {
  const btn = $("#sSave"), msg = $("#sMsg");
  btn.disabled = true; msg.textContent = "Saving & checking the key…";
  try {
    applyConfig(await api("/api/settings", { method: "POST", body: { api_key: $("#sKey").value, model: $("#sModel").value, effort: $("#sEffort").value } }));
    msg.textContent = "Saved ✓"; setTimeout(closeSettings, 600);
    if (state.video) {
      await refreshVideo(state.video.id);
      if (state.video.status?.stage === "needs_key" && state.config.has_api_key && confirm("Key saved. Let the AI find clips in this video now?")) startReclip(state.video.id, false);
    }
  } catch (e) { msg.textContent = e.message; msg.style.color = "var(--bad)"; setTimeout(() => (msg.style.color = ""), 4000); }
  btn.disabled = false;
}

async function boot() {
  applyConfig(await api("/api/config"));
  $("#keyBadge").onclick = openSettings;
  $("#navSettings").onclick = openSettings;
  const onScroll = () => $("#topbar").classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
  $("#newBtn").addEventListener("click", () => { if (!location.hash || location.hash === "#/") { scrollTo({ top: 0 }); $("#urlInput")?.focus(); } });
  $("#settingsClose").onclick = closeSettings;
  $("#settings").addEventListener("click", (e) => { if (e.target.id === "settings") closeSettings(); });
  $("#sSave").onclick = saveSettings;
  let asked = false; try { asked = !!sessionStorage.getItem("keyAsked"); sessionStorage.setItem("keyAsked", "1"); } catch {}
  if (!state.config.has_api_key && !asked) setTimeout(openSettings, 400);   // no key yet: ask once per session; the badge and callout remind after that
  await loadCampaigns();
  $("#campaignSelect").addEventListener("change", () => { try { localStorage.setItem("campaign", campaignSlug()); } catch {} if (state.video) renderClips(true); });
  window.addEventListener("hashchange", route);
  $("#drawerClose").onclick = closeDrawer;
  $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
  $("#pv").addEventListener("timeupdate", markCurrentWord);
  document.addEventListener("keydown", editorKeys);
  route();
}

async function loadCampaigns() {
  state.campaigns = await api("/api/campaigns");
  let saved = ""; try { saved = localStorage.getItem("campaign") || ""; } catch {}
  const sel = $("#campaignSelect"), keep = sel.value || saved;
  sel.innerHTML = `<option value="">No campaign</option>` + state.campaigns.map((c) => `<option value="${esc(c.slug)}">${esc(c.campaign_name)}</option>`).join("");
  sel.value = state.campaigns.some((c) => c.slug === keep) ? keep : "";
}

function route() {
  clearInterval(state.poll);
  $("#drawer").classList.add("hidden"); $("#pv").pause(); state.editing = null; state.dirty = false;   // an open editor never survives navigation state.io?.disconnect(); state.io2?.disconnect(); state.io = state.io2 = null;
  const h = location.hash, m = h.match(/^#\/v\/(.+)$/);
  const page = m ? "video" : h === "#/library" ? "library" : h === "#/campaigns" ? "campaigns" : h === "#/learn" ? "learn" : "home";
  $$("#sidebar [data-nav]").forEach((el) => { const on = el.dataset.nav === (page === "video" ? "library" : page); el.classList.toggle("active", on); on ? el.setAttribute("aria-current", "page") : el.removeAttribute("aria-current"); });
  $("#crumb").classList.toggle("hidden", page !== "video");
  $("#newBtn").classList.toggle("hidden", page === "home" || page === "library");
  scrollTo({ top: 0, behavior: "instant" });
  if (page === "video") showVideo(decodeURIComponent(m[1]));
  else ({ library: showLibrary, campaigns: showCampaigns, learn: showLearn, home: showHome })[page]();
}

function mount(tplId) {
  const app = $("#app"); app.innerHTML = ""; app.append($(tplId).content.cloneNode(true));
  state.io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); state.io.unobserve(e.target); } }), { threshold: 0.12 });
  $$(".reveal", app).forEach((el) => state.io.observe(el));
}

// ---------------- pages ----------------
function videoCards(vids) {
  return vids.map((v) => {
    const st = v.status?.stage;
    return `<a class="vitem" href="#/v/${esc(v.id)}">
      <div class="vthumb"><img src="/api/videos/${encodeURIComponent(v.id)}/thumb.jpg" alt="" loading="lazy" onerror="this.remove()">
        ${isBusy(st) ? `<span class="vprog"><span class="spin sm"></span>${Math.round((v.status.progress || 0) * 100)}%</span>` : `<span class="badge vstat ${st === "ready" ? "ok" : st === "error" ? "err" : ""}">${STAGE[st] || ""}</span>`}</div>
      <div class="vbody"><div class="vt">${esc(v.title)}</div>
        <div class="muted small">${v.duration ? mmss(v.duration) : "…"}${isBusy(st) && v.status?.message ? " · " + esc(v.status.message) : ""}</div></div></a>`;
  }).join("");
}

async function loadVideoList(limit) {
  const box = $("#videoList"); if (!box) return;
  let vids;
  try { vids = await api("/api/videos"); }
  catch (e) { box.innerHTML = `<p class="small" style="color:var(--bad)">Couldn't load your videos: ${esc(e.message)}</p>`; return; }
  if (!$("#videoList")) return;   // navigated away while loading
  if (!vids.length) {
    if (limit) { $("#stripWrap").classList.add("empty"); }
    else box.innerHTML = `<div class="panel" style="grid-column:1/-1;align-items:flex-start"><h2>No videos yet</h2><p class="muted">Paste a link on the Home page to get started.</p><a class="btn primary" href="#/">Add a video</a></div>`;
    return;
  }
  box.innerHTML = videoCards(limit ? vids.slice(0, limit) : vids);
}

async function showHome() {
  state.video = null; document.title = "Clipper"; mount("#tpl-home");
  $("#urlForm").onsubmit = async (e) => {
    e.preventDefault(); askNotify();
    const b = $("#urlForm .go"); b.disabled = true;
    try { const job = await api("/api/videos", { method: "POST", body: { url: $("#urlInput").value.trim() } }); location.hash = `#/v/${job.video_id}`; }
    catch (err) { toast(err.message, true); b.disabled = false; }
  };
  $("#uploadBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = (e) => e.target.files[0] && uploadFile(e.target.files[0]);
  const hero = $(".hero");
  hero.ondragover = (e) => { e.preventDefault(); hero.classList.add("drop"); };
  hero.ondragleave = () => hero.classList.remove("drop");
  hero.ondrop = (e) => { e.preventDefault(); hero.classList.remove("drop"); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); };
  await loadVideoList(4);
}

function showLibrary() { state.video = null; document.title = "Library · Clipper"; mount("#tpl-library"); loadVideoList(0); }

function showCampaigns() {
  state.video = null; document.title = "Campaigns · Clipper"; mount("#tpl-campaigns");
  $("#campParse").onclick = async () => {
    const btn = $("#campParse"); btn.disabled = true; btn.textContent = "Reading the rules…";
    try {
      const c = await api("/api/campaigns", { method: "POST", body: { brief: $("#campBrief").value, name: $("#campName").value || null } });
      $("#campResult").innerHTML = rulesHtml(c); await loadCampaigns(); $("#campaignSelect").value = c.slug;
      try { localStorage.setItem("campaign", c.slug); } catch {}
      renderCampList(); toast(`Campaign “${c.campaign_name}” saved and selected.`);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Save campaign";
  };
  renderCampList();
}

function showLearn() {
  state.video = null; document.title = "Guide · Clipper"; mount("#tpl-learn");
  const go = () => { location.hash = "#/"; setTimeout(() => $("#urlInput")?.focus(), 100); };
  $("#floatCta").onclick = go; $("#closingCta").onclick = go;
  $("#demoToggle").onclick = () => {
    const p = $("#demo").classList.toggle("paused");
    $("#demoToggle").setAttribute("aria-label", p ? "Play the demo animation" : "Pause the demo animation");
    $("#demoToggle use").setAttribute("href", p ? "#i-play" : "#i-pause");
  };
  // the floating button appears once the page header has scrolled out of view
  state.io2 = new IntersectionObserver(([e]) => $("#floatCta")?.classList.toggle("hidden", e.isIntersecting), { threshold: 0 });
  state.io2.observe($(".page-head"));
  $("#faqAll").onclick = () => {
    const all = $$(".faq details"), open = all.every((d) => d.open);
    all.forEach((d) => (d.open = !open)); $("#faqAll").textContent = open ? "Expand all" : "Collapse all";
  };
}

function uploadFile(f) {
  askNotify();
  const msg = $("#homeMsg"), fd = new FormData(), xhr = new XMLHttpRequest();
  fd.append("file", f); fd.append("title", f.name.replace(/\.[^.]+$/, ""));
  xhr.open("POST", "/api/videos/upload");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) msg.textContent = `Uploading ${f.name}… ${Math.round((e.loaded / e.total) * 100)}%`; };
  xhr.onload = () => {
    if (xhr.status < 300) { location.hash = `#/v/${JSON.parse(xhr.responseText).video_id}`; return; }
    let m = xhr.statusText; try { m = JSON.parse(xhr.responseText).detail; } catch {}
    msg.textContent = ""; toast(m, true);
  };
  xhr.onerror = () => { msg.textContent = ""; toast("Upload failed. Is Clipper still running?", true); };
  msg.textContent = `Uploading ${f.name}…`;
  xhr.send(fd);
}

function rulesHtml(c) {
  const r = [];
  if (c.min_seconds || c.max_seconds) r.push(`${c.min_seconds || 0}–${c.max_seconds || "∞"}s`);
  if (c.language) r.push(LANG[c.language] || c.language);
  (c.must_mention || []).forEach((m) => r.push(`must mention: ${m}`));
  [...(c.required_hashtags || []), ...(c.required_tags || [])].forEach((h) => r.push(h));
  (c.required_caption_text || []).forEach((h) => r.push(`caption: “${h}”`));
  (c.banned_words || []).forEach((b) => r.push(`banned: ${b}`));
  (c.banned_topics || []).forEach((b) => r.push(`banned topic: ${b}`));
  if (c.captions_required) r.push("captions required");
  if (c.no_watermark) r.push("no watermark");
  (c.other_rules || []).forEach((o) => r.push(o));
  return `<div class="rules">${r.map((x) => `<span class="rule">${esc(x)}</span>`).join("")}</div>`;
}

function renderCampList() {
  const el = $("#campList"); if (!el) return;
  if (!state.campaigns.length) { el.innerHTML = `<p class="muted small">No campaigns yet. Paste one on the left.</p>`; return; }
  el.innerHTML = state.campaigns.map((c) => `<div class="vitem"><b>${esc(c.campaign_name)}</b>${rulesHtml(c)}</div>`).join("");
}

// ---------------- video page ----------------
async function showVideo(id) {
  if (state.video?.id !== id) state.video = null;
  mount("#tpl-video"); $("#crumb").classList.remove("hidden"); $("#vTitle").textContent = state.video?.id === id ? state.video.title : "Loading…";
  state.selected.clear(); state.sel = [null, null]; state.eta = null; state.transcript = null; renderClips._sig = null;
  $$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $("#sortBy").onchange = (e) => { state.sort = e.target.value; renderClips(true); };
  $("#reclip").onclick = () => startReclip(id, true);
  $("#checkCamp").onclick = () => checkCampaign(id);
  $("#bulkExport").onclick = () => bulkExport(id);
  $("#selectAll").onchange = (e) => {
    const ids = (state.video?.clips || []).map((c) => c.id);
    ids.forEach((i) => (e.target.checked ? state.selected.add(i) : state.selected.delete(i))); renderClips(true);
  };
  $("#momentForm").onsubmit = (e) => { e.preventDefault(); findMoments(id); };
  $$("#momentIdeas .chip").forEach((b) => (b.onclick = () => { $("#momentQuery").value = b.textContent; findMoments(id); }));
  $("#makeClip").onclick = () => makeClipFromSelection(id);
  $("#keyCtaBtn").onclick = openSettings;
  await refreshVideo(id);
  startPolling(id);
}

async function startReclip(id, ask) {
  const n = state.video?.clips?.length || 0;
  if (ask && n && !confirm(`Find clips again?\n\nThis replaces all ${n} clips on this video, including clips you made or edited by hand.`)) return;
  askNotify();
  try {
    await api(`/api/videos/${id}/clip`, { method: "POST" });
    state.selected.clear();
    if (state.video) state.video.status = { stage: "queued", progress: 0 };   // so polling resumes immediately
    state.eta = null; toast("Finding clips…"); startPolling(id); refreshVideo(id);
  }
  catch (e) { toast(e.message, true); }
}

function switchTab(tab) {
  $$(".tabs button").forEach((b) => { b.classList.toggle("active", b.dataset.tab === tab); b.setAttribute("aria-selected", b.dataset.tab === tab); });
  ["clips", "moments", "transcript"].forEach((t) => $(`#tab-${t}`).classList.toggle("hidden", t !== tab));
  if (tab === "transcript") renderTranscript();
}

function startPolling(id) {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (!isBusy(state.video?.status?.stage)) return;
    await refreshVideo(id);
  }, 2000);
}

function etaText(st) {
  const now = Date.now(), p = st.progress || 0, e = (state.eta ||= { t: now, p });
  if (p < e.p) Object.assign(e, { t: now, p });
  const rate = (p - e.p) / (now - e.t);
  if (!(rate > 0) || now - e.t < 8000) return "estimating time…";
  const s = (1 - p) / rate / 1000;
  return s < 60 ? "less than a minute left" : `about ${Math.round(s / 60)} min left`;
}

function friendlyError(e = "") {
  if (/not a bot|Sign in to confirm/i.test(e)) return "YouTube blocked the download (bot check). Try again later or on another network, or download the video yourself and use Upload file.";
  if (/Unsupported URL/i.test(e)) return "That link isn't a video page Clipper can open. Paste the video's own URL.";
  if (/Private video|members-only|HTTP Error 403/i.test(e)) return "That video is private or restricted.";
  return e.replace(/^ERROR:\s*/, "");
}

async function refreshVideo(id) {
  let v;
  try { v = await api(`/api/videos/${id}`); }
  catch (e) {
    if (location.hash !== "#/v/" + id) return;
    if (/unknown video/i.test(e.message)) { $("#app").innerHTML = `<div class="panel" style="align-items:flex-start"><h2>Video not found</h2><p class="muted">It may have been deleted from the data folder.</p><a class="btn primary" href="#/library">Back to Library</a></div>`; $("#vTitle").textContent = ""; return; }
    toast(e.message, true); return;
  }
  if (!$("#vProgress") || location.hash !== "#/v/" + id) return;   // the user already left this page
  const prevStage = state.video?.id === id ? state.video?.status?.stage : undefined;
  state.video = v;
  const st = v.status || {}, busy = isBusy(st.stage);
  if (busy) document.title = `${Math.round((st.progress || 0) * 100)}% · ${v.title || "Clipper"}`;
  else if (isBusy(prevStage)) {                       // a real transition, not a page load
    const n = (v.clips || []).length;
    if (st.stage === "error") signalDone("Processing failed", v.title, false);
    else if (st.stage === "needs_key") signalDone("Transcript ready", "Add your API key to get AI clips.");
    else signalDone(`${n} clips ready`, v.title);
  } else if (!/^[✓!]/.test(document.title)) document.title = `${v.title || "Clipper"} · Clipper`;

  $("#vTitle").textContent = v.title || id;
  $("#vTitle").title = v.title || id; $("#vTitleM").textContent = v.title || id;
  const vertical = v.width && v.height > v.width;
  $("#vMeta").textContent = [v.duration && mmss(v.duration), v.language && (LANG[v.language] || v.language), vertical && "already vertical", v.channel].filter(Boolean).join(" · ");
  const usd = v.cost?.usd || 0;
  $("#vCost").textContent = `AI cost ${usd && usd < 0.01 ? "< $0.01" : "$" + usd.toFixed(2)}`;
  const stepName = { clipping: "Finding clips", scoring: "Scoring", moments: "Find Moments", variants: "Variants & captions", campaign_parse: "Reading campaign", campaign_check: "Checking rules" };
  $("#vCost").title = v.cost?.by_step ? Object.entries(v.cost.by_step).map(([k, x]) => `${stepName[k] || k}: $${x}`).join("\n") : "No AI calls yet";

  const prog = $("#vProgress");
  prog.classList.toggle("hidden", !busy && st.stage !== "error");
  const items = $$(".steps li", prog), idx = items.findIndex((li) => li.dataset.steps.split(" ").includes(st.stage));
  items.forEach((li, i) => { li.classList.toggle("done", i < idx); li.classList.toggle("now", i === idx); });
  $(".bar", prog).classList.toggle("hidden", st.stage === "error");
  $(".bar span", prog).style.width = `${Math.round((st.progress || 0) * 100)}%`;
  $(".msg", prog).textContent = st.error ? `Couldn't process this video. ${friendlyError(st.error)}`
    : `${st.message || STAGE[st.stage] || ""} · ${Math.round((st.progress || 0) * 100)}% · ${etaText(st)}. Feel free to switch tabs: ${prefs.chime ? "you'll hear a chime" : "the tab title updates"} when it's done.`;
  $(".msg", prog).style.color = st.error ? "var(--bad)" : "";
  $("#errActions").classList.toggle("hidden", st.stage !== "error");
  $("#retry").onclick = async () => {
    try {
      v.source_url && !(v.clips || []).length ? await api("/api/videos", { method: "POST", body: { url: v.source_url } }) : await api(`/api/videos/${id}/clip`, { method: "POST" });
      state.eta = null; startPolling(id); refreshVideo(id);
    } catch (e) { toast(e.message, true); }
  };
  $("#reclip").disabled = busy;
  $("#keyCta").classList.toggle("hidden", st.stage !== "needs_key");
  if (prevStage !== st.stage && (st.stage === "ready" || st.stage === "needs_key")) state.transcript = null;
  renderClips();
}

function compliance(c) { const s = campaignSlug(); return s && c.checks?.[s]; }

function compLabel(comp) {
  if (comp.after_fixes === "pass") return comp.status === "pass" ? "✓ Meets rules" : "✓ Meets rules after auto-fix";
  return comp.after_fixes === "warn" ? "Check rules" : "Breaks rules";
}

const ACTIONS = [
  ["edit", "pencil", "Edit clip", null], ["trim", "scissors", "Cut words", "#eWords"], ["reframe", "crop", "Layout and reframe", "#eLayouts"],
  ["variants", "sparkles", "Variants and captions", "#eVariants"], ["export", "download", "Export this clip", null], ["delete", "trash", "Delete clip", null]];

function clipCard(c, v) {
  const comp = compliance(c), dur = c.edited_duration ?? c.duration;
  const edited = (c.removed_words || []).length > 0 || (c.edited_duration != null && Math.abs(c.edited_duration - c.duration) > 0.2);
  const n = (v.clips || []).indexOf(c) + 1;
  const dimTip = c.dims ? DIMS.map((d) => `${d} ${c.dims[d].score}: ${c.dims[d].reason}`).join("\n") : "Not scored yet";
  const desc = c.verdict || c.why || c.hook_text || "";
  return `<article class="card" data-id="${c.id}">
    <div class="card-head">
      <label class="pick" title="Select this clip"><input type="checkbox" data-pick="${c.id}" ${state.selected.has(c.id) ? "checked" : ""} aria-label="Select ${esc(c.title)}"></label>
      <div class="ct" title="${esc(c.title)}">#${n} ${esc(c.title)}</div>
    </div>
    <div class="thumb" data-thumb="${c.id}" role="button" tabindex="0" aria-label="Edit ${esc(c.title)}">
      <img src="/api/videos/${encodeURIComponent(v.id)}/clips/${encodeURIComponent(c.id)}/thumb.jpg?t=${c.start}" alt="" loading="lazy" onerror="this.remove()">
      <span class="play">${icon("play")}</span>
      <span class="chips-top">${edited ? `<span class="tchip edited">Edited</span>` : ""}<span class="tchip" title="${Math.round(dur)} seconds">${mmssp(c.start)} - ${mmssp(c.end)}</span></span>
    </div>
    <div class="cbody">
      <div class="scorerow" title="${esc(dimTip)}">
        ${c.score != null ? `<span class="sc" style="color:${scoreColor(c.score)}">${c.score}</span><span class="of">/100</span>` : `<span class="of">Not scored</span>`}
        ${comp ? `<span class="comp ${comp.after_fixes}" title="As-is: ${comp.status}. After auto-fixes at export: ${comp.after_fixes}">${compLabel(comp)}</span>` : ""}
      </div>
      <div class="actions">${ACTIONS.map(([k, ic, label]) => `<button type="button" class="icon-btn ${k === "delete" ? "warn" : ""}" data-act="${k}" ${k === "edit" ? `data-edit="${c.id}"` : ""} aria-label="${label}" title="${label}">${icon(ic)}</button>`).join("")}</div>
      <p class="desc">${esc(desc)}</p>
      <div class="tags"><span class="tag cat-${esc(c.category)}">${esc(c.category)}</span><span class="muted small">${Math.round(dur)}s</span></div>
    </div></article>`;
}

function renderClips(force = false) {
  const v = state.video; if (!v || !$("#clips")) return;
  let clips = [...(v.clips || [])];
  const known = new Set(clips.map((c) => c.id)); [...state.selected].forEach((i) => known.has(i) || state.selected.delete(i));   // deleted / re-generated clips
  if (state.sort === "time") clips.sort((a, b) => a.start - b.start);
  else if (state.sort === "compliance") { const o = { pass: 0, warn: 1, fail: 2 }; clips.sort((a, b) => (o[compliance(a)?.after_fixes] ?? 3) - (o[compliance(b)?.after_fixes] ?? 3) || (b.score ?? 0) - (a.score ?? 0)); }
  else clips.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  $("#tabCount").textContent = clips.length;
  // Polling refreshes every 2 s: only redraw when something visible changed.
  const sig = JSON.stringify([clips, state.sort, campaignSlug(), [...state.selected], v.status?.stage]);
  if (!force && sig === renderClips._sig && $("#clips").childElementCount) return;
  renderClips._sig = sig;
  if (!clips.length && isBusy(v.status?.stage)) {
    $("#clipCount").textContent = "Clips will appear here when processing finishes.";
    $("#clips").innerHTML = Array(6).fill(`<div class="card skel" aria-hidden="true"><div class="sk sk-thumb"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>`).join("");
    updateBulk(); return;
  }
  $("#clipCount").textContent = clips.length ? "" : (v.status?.stage === "needs_key" ? "No AI clips yet. You can make clips by hand in the Transcript tab." : "No clips yet.");
  $("#clips").innerHTML = clips.map((c) => clipCard(c, { ...v, clips })).join("");
  $$("[data-edit]").forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  $$("[data-act]").forEach((b) => {
    const id = b.closest(".card").dataset.id, k = b.dataset.act, focus = ACTIONS.find((a) => a[0] === k)[3];
    if (k === "edit") return;
    b.onclick = () => (k === "export" ? runExport(v.id, [id]) : k === "delete" ? deleteClip(v.id, id) : openEditor(id, focus));
  });
  $$(".thumb").forEach((el) => {
    el.onclick = () => openEditor(el.dataset.thumb);
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEditor(el.dataset.thumb); } };
  });
  $$("[data-pick]").forEach((b) => (b.onchange = () => { b.checked ? state.selected.add(b.dataset.pick) : state.selected.delete(b.dataset.pick); updateBulk(); b.closest(".card").classList.toggle("picked", b.checked); }));
  $$("[data-pick]:checked").forEach((b) => b.closest(".card").classList.add("picked"));
  updateBulk();
}

async function deleteClip(vid, id) {
  if (!confirm("Delete this clip?")) return;
  try { await api(`/api/videos/${vid}/clips/${id}`, { method: "DELETE" }); state.selected.delete(id); await refreshVideo(vid); toast("Clip deleted."); }
  catch (e) { toast(e.message, true); }
}

function updateBulk() {
  const n = state.selected.size, ids = (state.video?.clips || []).map((c) => c.id);
  $("#bulkBar")?.classList.toggle("active", n > 0);
  if ($("#bulkCount")) $("#bulkCount").textContent = n ? `${n} selected${campaignSlug() ? " · campaign: " + $("#campaignSelect").selectedOptions[0].text : ""}` : "Select clips to enable bulk actions";
  if ($("#bulkExport")) $("#bulkExport").disabled = !n || state.exporting;
  if ($("#bulkVariants")) { $("#bulkVariants").disabled = !n; $("#bulkVariants").closest(".select-pill").title = n ? "" : "Select clips first"; }
  const all = $("#selectAll");
  if (all) {
    const k = ids.filter((i) => state.selected.has(i)).length;
    all.checked = ids.length > 0 && k === ids.length; all.indeterminate = k > 0 && k < ids.length; all.disabled = !ids.length;
    $("#selectAllLbl").textContent = ids.length ? `Select all ${ids.length} clip${ids.length > 1 ? "s" : ""}` : "Select all clips";
  }
}

async function checkCampaign(id) {
  const slug = campaignSlug();
  if (!slug) return toast("Pick (or create) a campaign at the top first.", true);
  const btn = $("#checkCamp"), lbl = $("span", btn); btn.disabled = true; lbl.textContent = "Checking…";
  try { await waitJob(await api(`/api/videos/${id}/check/${slug}`, { method: "POST" })); await refreshVideo(id); state.sort = "compliance"; $("#sortBy").value = "compliance"; renderClips(true); toast("Campaign check done."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; lbl.textContent = "Check campaign rules";
}

async function bulkExport(id) { return runExport(id, [...state.selected]); }

async function runExport(id, ids) {
  if (state.exporting || !ids.length) return;
  state.exporting = true; updateBulk();
  const btn = $("#bulkExport"), lbl = btn ? $("span", btn) : document.createElement("span"), single = ids.length === 1 && state.selected.size !== 1;
  try {
    if (single) toast("Exporting this clip…", false, 0);
    const job = await api(`/api/videos/${id}/export`, { method: "POST", body: { clip_ids: ids, campaign: campaignSlug() || null, variants: +$("#bulkVariants").value } });
    const res = await waitJob(job, (j) => { const t = `Exporting… ${Math.round(j.progress * 100)}%`; lbl.textContent = t; if (single) toast(t, false, 0); });
    const items = res.exports.map((e) => `<div class="exp"><b>${esc(e.folder.split("/").pop())}</b><div>${e.files.map((f) => `<a href="/${e.folder.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(f)}" target="_blank" rel="noopener">${esc(f)}</a>`).join(" · ")}</div></div>`).join("");
    const where = res.exports[0]?.folder.split("/").slice(0, -1).join("/") || "output";
    toast(`<b>Exported ${res.exports.length} clip${res.exports.length > 1 ? "s" : ""} ✓</b><div class="muted small">Saved in your Clipper folder → ${esc(where.replace(/\//g, " → "))}</div>${items}<button class="btn primary sm open-folder" id="openFolder" type="button">Open folder</button>`, false, 0, true);
    $("#openFolder").onclick = () => api("/api/open-folder", { method: "POST", body: { folder: res.exports.length > 1 ? where : res.exports[0].folder } }).catch((e) => toast(e.message, true));
    signalDone(`Exported ${res.exports.length} clip${res.exports.length > 1 ? "s" : ""}`, "");
    ids.forEach((i) => state.selected.delete(i));
  } catch (e) { toast(e.message, true); }
  state.exporting = false; lbl.textContent = "Bulk Export"; renderClips(true); updateBulk();
}

// ---------------- find moments ----------------
async function findMoments(id) {
  const q = $("#momentQuery").value, box = $("#moments");
  box.innerHTML = Array(3).fill(`<div class="card skel" aria-hidden="true"><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>`).join("");
  try {
    const res = await api(`/api/videos/${id}/moments`, { method: "POST", body: { query: q } });
    box.innerHTML = res.length ? res.map((m, i) => `<div class="moment">
      <div class="score" style="color:${scoreColor(m.match_score)}">${m.match_score}</div>
      <div><b>${esc(m.title)}</b> <span class="muted small">${mmss(m.start)}–${mmss(m.end)} · ${m.duration.toFixed(1)}s</span><br><q>${esc(m.quote)}</q><div class="small">${esc(m.why)}</div></div>
      <div class="acts"><button class="btn ghost sm" type="button" data-play="${i}">▶ Play</button><button class="btn primary sm" type="button" data-add="${i}">Add as clip</button></div></div>`).join("") : `<p class="muted">Nothing matched. Try a broader search.</p>`;
    $$("[data-add]", box).forEach((b) => (b.onclick = async () => {
      const m = res[+b.dataset.add];
      try { await api(`/api/videos/${id}/clips`, { method: "POST", body: { start_sentence: m.start_sentence, end_sentence: m.end_sentence, title: m.title, why: `Find Moments: ${m.why}` } }); b.textContent = "Added ✓"; b.disabled = true; refreshVideo(id); } catch (e) { toast(e.message, true); }
    }));
    $$("[data-play]", box).forEach((b) => (b.onclick = () => { const m = res[+b.dataset.play]; openSourcePlayer(id, m.start, m.end); }));
  } catch (e) {
    box.innerHTML = /API key/i.test(e.message) ? `<div class="callout"><div>Find Moments needs the AI. Add your API key first.</div><button class="btn primary" type="button" id="mKey">Add API key</button></div>` : `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`;
    $("#mKey")?.addEventListener("click", openSettings);
  }
}

function openSourcePlayer(id, start, end) {
  state.editing = null;
  if ($("#drawer").classList.contains("hidden")) remember("drawer");
  $("#drawer").classList.remove("hidden");
  $(".edit-col").classList.add("hidden");
  playRange($("#pv"), `/media/${id}/source.mp4`, start, end);
}

function playRange(video, src, start, end) {
  if (!video.src.endsWith(src)) video.src = src;
  video.ontimeupdate = () => { if (end && video.currentTime >= end) { video.pause(); video.ontimeupdate = null; } };
  const go = () => { video.currentTime = start; video.play().catch(() => {}); };
  video.readyState >= 1 ? go() : (video.onloadedmetadata = go);
}

// ---------------- transcript tab ----------------
async function loadTranscript() {
  if (!state.transcript) state.transcript = await api(`/api/videos/${state.video.id}/transcript`);
  return state.transcript;
}

async function renderTranscript() {
  let t; try { t = await loadTranscript(); } catch { $("#transcript").innerHTML = `<p class="muted">Transcript not ready yet.</p>`; return; }
  const box = $("#transcript");
  box.innerHTML = t.sentences.map((s) => `<div class="sent" data-i="${s.i}"><span class="t">${mmss(s.s)}</span><span class="s" title="Speaker ${s.spk || 1} (approximate)">S${s.spk || 1}</span><span>${esc(s.text)}</span></div>`).join("");
  box.onmousedown = (e) => { if (e.shiftKey) e.preventDefault(); };   // shift-click selects sentences, not page text
  $$(".sent", box).forEach((el) => (el.onclick = (e) => {
    const i = +el.dataset.i;
    if (e.shiftKey && state.sel[0] != null) state.sel[1] = i; else state.sel = [i, i];
    const [a, b] = [Math.min(...state.sel), Math.max(...state.sel)];
    $$(".sent", box).forEach((x) => x.classList.toggle("sel", +x.dataset.i >= a && +x.dataset.i <= b));
    const d = t.sentences[b].e - t.sentences[a].s;
    $("#selInfo").textContent = `${b - a + 1} sentence${b > a ? "s" : ""} selected · ${d.toFixed(1)}s`;
    $("#makeClip").disabled = false; $("#makeClip").textContent = `Make ${Math.round(d)}s clip`;
  }));
}

async function makeClipFromSelection(id) {
  const [a, b] = [Math.min(...state.sel), Math.max(...state.sel)];
  const t = await loadTranscript();
  const title = t.sentences[a].text.split(" ").slice(0, 8).join(" ");
  try { const c = await api(`/api/videos/${id}/clips`, { method: "POST", body: { start_sentence: a, end_sentence: b, title } }); toast(`Clip added: “${c.title}”.`); await refreshVideo(id); switchTab("clips"); }
  catch (e) { toast(e.message, true); }
}

// ---------------- editor ----------------
async function openEditor(clipId, focus = null) {
  const v = state.video, c = v.clips.find((x) => x.id === clipId); if (!c) return;
  const t = await loadTranscript();
  state.editing = { clip: c, removed: new Set(c.removed_words || []), style: c.style || "bold-pop", layout: c.layout || "auto" };
  state.dirty = false;
  if ($("#drawer").classList.contains("hidden")) remember("drawer");
  $("#drawer").classList.remove("hidden"); $(".edit-col").classList.remove("hidden");
  $("#eTitle").value = c.title; $("#eHook").value = c.hook_text || "";
  $("#eTitle").oninput = $("#eHook").oninput = () => (state.dirty = true);
  $("#eMeta").textContent = `${c.category} · ${mmss(c.start)}–${mmss(c.end)}${c.why ? " · " + c.why : ""}`;
  $("#eScore").innerHTML = c.dims ? `<details class="why"><summary><span class="ring sm" style="--p:${c.score};--c:${scoreColor(c.score)}"><b>${c.score}</b></span><span>${esc(c.verdict || "Viral score")}</span><span class="muted small">Why this score?</span></summary><div class="checks">${DIMS.map((d) => `<div class="check"><span style="color:${scoreColor(c.dims[d].score)}">${c.dims[d].score}</span><div><b>${d}</b>: ${esc(c.dims[d].reason)}<div class="d">Fix: ${esc(c.dims[d].fix)}</div></div></div>`).join("")}</div></details>` : "";
  $("#eStyles").innerHTML = Object.entries(state.config.caption_styles).map(([k, l]) => `<button class="chip ${k === state.editing.style ? "on" : ""}" type="button" data-style="${k}">${esc(l)}</button>`).join("");
  $("#eLayouts").innerHTML = state.config.layouts.map((k) => `<button class="chip ${k === state.editing.layout ? "on" : ""}" type="button" data-layout="${k}">${LAYOUT[k] || k}</button>`).join("");
  $$("[data-style]").forEach((b) => (b.onclick = () => { state.editing.style = b.dataset.style; state.dirty = true; $$("[data-style]").forEach((x) => x.classList.toggle("on", x === b)); }));
  $$("[data-layout]").forEach((b) => (b.onclick = () => { state.editing.layout = b.dataset.layout; state.dirty = true; $$("[data-layout]").forEach((x) => x.classList.toggle("on", x === b)); }));
  renderWords(t);
  renderChecks(c);
  renderVariants(c);
  $("#pvMsg").textContent = "";
  playRange($("#pv"), `/media/${v.id}/source.mp4`, c.start, c.end);
  $("#playSource").onclick = () => playRange($("#pv"), `/media/${v.id}/source.mp4`, state.editing.clip.start, state.editing.clip.end);
  $("#renderPreview").onclick = () => renderPreview();
  $("#eSave").onclick = () => saveEdits();
  $("#eRestore").onclick = () => { state.editing.removed.clear(); state.dirty = true; renderWords(t); };
  $("#eDelete").onclick = async () => { if (!confirm("Delete this clip?")) return; await api(`/api/videos/${v.id}/clips/${c.id}`, { method: "DELETE" }); state.dirty = false; closeDrawer(); refreshVideo(v.id); };
  $("#eVariants").onclick = () => makeVariants();
  $("#eVariants").textContent = c.variants ? "Regenerate variants" : "Generate 3 variants + platform captions";
  $$("[data-nudge]").forEach((b) => (b.onclick = () => nudge(...b.dataset.nudge.split(","))));
  $("#drawerClose").focus({ preventScroll: true });
  if (focus) setTimeout(() => $(focus)?.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }), 120);
}

function renderWords(t) {
  const c = state.editing.clip, box = $("#eWords");
  const words = t.words.slice(c.w0, c.w1 + 1);
  box.innerHTML = words.map((w) => `<span class="w ${state.editing.removed.has(w.i) ? "cut" : ""}" data-w="${w.i}" role="button" tabindex="0">${esc(w.w)}</span>`).join(" ");
  $$(".w", box).forEach((el) => (el.onclick = () => {
    const i = +el.dataset.w;
    state.editing.removed.has(i) ? state.editing.removed.delete(i) : state.editing.removed.add(i);
    el.classList.toggle("cut"); state.dirty = true;
    $$("#eWords .w.last").forEach((x) => x.classList.remove("last")); el.classList.add("last");
    updateDur(t);
  }));
  updateDur(t);
}

function updateDur(t) {
  const c = state.editing.clip;
  const cut = t.words.slice(c.w0, c.w1 + 1).filter((w) => state.editing.removed.has(w.i)).reduce((s, w) => s + (w.e - w.s), 0);
  $("#eDur").textContent = `≈ ${(c.end - c.start - cut).toFixed(1)}s after cuts`;
}

function markCurrentWord() {
  const pv = $("#pv"), words = state.transcript?.words;
  if (!state.editing || !words || !pv.currentSrc.includes("/source.mp4")) return;
  const t = pv.currentTime; let cur = null;
  $$("#eWords .w").forEach((el) => { const w = words[+el.dataset.w], on = t >= w.s && t < w.e; el.classList.toggle("now", on); if (on) cur = el; });
  cur?.scrollIntoView({ block: "nearest" });
}

function editorKeys(e) {
  if (e.key === "Escape" && !$("#settings").classList.contains("hidden")) return closeSettings();
  if ($("#drawer").classList.contains("hidden")) return;
  if (e.key === "Escape") return closeDrawer();
  if (!state.editing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); return saveEdits(); }
  if (e.target.classList?.contains("w") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return e.target.click(); }   // keyboard: cut/restore the focused word
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const pv = $("#pv");
  if (e.key === " ") { e.preventDefault(); pv.paused ? pv.play().catch(() => {}) : pv.pause(); }
  else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); ($("#eWords .w.now") || $("#eWords .w.last"))?.click(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); stepClip(e.key === "ArrowRight" ? 1 : -1); }
}

async function stepClip(d) {
  const ids = $$("#clips .card[data-id]").map((x) => x.dataset.id), next = ids[ids.indexOf(state.editing.clip.id) + d];
  if (!next) return;
  if (state.dirty) await saveEdits(true);
  openEditor(next);
}

async function saveEdits(silent = false) {
  const v = state.video, e = state.editing;
  const body = { title: $("#eTitle").value, hook_text: $("#eHook").value, style: e.style, layout: e.layout, removed_words: [...e.removed] };
  try { const c = await api(`/api/videos/${v.id}/clips/${e.clip.id}`, { method: "PATCH", body }); Object.assign(e.clip, c); state.dirty = false; if (!silent) toast("Saved."); await refreshVideo(v.id); return true; }
  catch (err) { toast(err.message, true); return false; }
}

async function nudge(edge, delta) {
  const v = state.video, c = state.editing.clip;
  if (state.dirty && !(await saveEdits(true))) return;
  const body = edge === "start" ? { start_sentence: c.start_sentence + +delta } : { end_sentence: c.end_sentence + +delta };
  try {
    const nc = await api(`/api/videos/${v.id}/clips/${c.id}`, { method: "PATCH", body });
    Object.assign(c, nc); state.editing.removed = new Set(c.removed_words || []);
    renderWords(await loadTranscript()); $("#eMeta").textContent = `${c.category} · ${mmss(c.start)}–${mmss(c.end)}`;
    playRange($("#pv"), `/media/${v.id}/source.mp4`, c.start, c.end); refreshVideo(v.id);
  } catch (e) { toast(e.message, true); }
}

async function renderPreview(variant = null) {
  if (!variant && !(await saveEdits(true))) return;
  const v = state.video, c = state.editing.clip, msg = $("#pvMsg"), btn = $("#renderPreview"), busy = $("#pvBusy"), t0 = Date.now();
  btn.disabled = true; busy.classList.remove("hidden"); msg.textContent = "";
  const tick = setInterval(() => ($("span", busy).textContent = `Rendering preview… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
  try {
    const job = await api(`/api/videos/${v.id}/clips/${c.id}/preview`, { method: "POST", body: { variant } });
    const res = await waitJob(job);
    const pv = $("#pv"); pv.ontimeupdate = null; pv.src = res.url; pv.play().catch(() => {});
    msg.textContent = variant ? `Variant ${variant} preview (low-res)` : "9:16 preview (low-res; export renders full 1080×1920)";
    if (document.hidden) signalDone("Preview ready", c.title);
  } catch (e) { toast(e.message, true); }
  finally { clearInterval(tick); busy.classList.add("hidden"); $("span", busy).textContent = "Rendering preview…"; btn.disabled = false; }
}

function renderChecks(c) {
  const comp = compliance(c), box = $("#eChecks");
  if (!comp) { box.innerHTML = `<span class="muted small">${campaignSlug() ? "Press “Check campaign rules” on the clips page." : "Pick a campaign at the top, then press “Check campaign rules”."}</span>`; return; }
  const lbl = { pass: "OK", fail: "Fails", warn: "Check" };
  const head = comp.status === comp.after_fixes ? `<p class="small"><b>${comp.status === "pass" ? "Meets every rule" : "Doesn't meet the rules yet"}</b></p>`
    : `<p class="small">Fails as-is · <b style="color:var(--good)">${comp.after_fixes === "pass" ? "passes" : comp.after_fixes}</b> after ${comp.fixes.length} automatic fix${comp.fixes.length > 1 ? "es" : ""} at export</p>`;
  box.innerHTML = head + `<div class="checks">${comp.rows.map((r) => `<div class="check ${r.status}"><span class="dot" role="img" aria-label="${lbl[r.status]}"></span><div>${esc(r.rule)} <span class="d">${esc(r.detail)}${r.by === "ai" ? " · checked by AI" : ""}</span></div></div>`).join("")}</div>`
    + (comp.fixes.length ? `<p class="small">Auto-fixes applied at export:<br>${comp.fixes.map((f) => "• " + esc(f)).join("<br>")}</p>` : "")
    + `<p class="small muted">Hashtags, tags and caption text are added to every platform caption automatically at export.</p>`;
}

function renderVariants(c) {
  const box = $("#eVariantList");
  if (!c.variants) { box.innerHTML = ""; return; }
  const note = state.config?.has_api_key ? "" : `<p class="muted small" style="grid-column:1/-1">Captions are the same until you add an API key. Zoom, speed and layout still differ.</p>`;
  box.innerHTML = note + c.variants.map((v) => `<div class="variant">
    <b>Variant ${v.n}</b><span class="muted small">${esc(v.angle)} · ${esc(v.plan.style)} · zoom ${v.plan.zoom} · ${v.plan.speed}x · ${esc(v.plan.layout)}${v.clip_patch?.start ? " · new cut" : ""}</span>
    <div class="hookline"><span class="hook-lbl">HOOK</span>${esc(v.hook_text)}</div>
    ${Object.entries(v.posts).map(([p, post]) => { const txt = `${post.caption} ${post.hashtags.join(" ")}`.trim(); return `<div class="post">
      <div class="post-h"><b>${PLATFORM[p] || p}</b><button class="copy" type="button" data-copy="${esc(txt)}" aria-label="Copy ${PLATFORM[p] || p} caption">Copy</button></div>
      ${post.title ? `<div class="post-title">${esc(post.title)} <button class="copy" type="button" data-copy="${esc(post.title)}" aria-label="Copy title">Copy title</button></div>` : ""}
      <div class="muted">${esc(txt)}</div></div>`; }).join("")}
    <button class="btn primary sm" type="button" data-vprev="${v.n}">Preview variant</button></div>`).join("");
  $$("[data-vprev]", box).forEach((b) => (b.onclick = () => renderPreview(+b.dataset.vprev)));
  $$("[data-copy]", box).forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const o = b.textContent; b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = o), 1200); }
    catch { toast("Couldn't copy. Select the text and copy it by hand.", true); }
  }));
}

async function makeVariants() {
  const v = state.video, c = state.editing.clip, btn = $("#eVariants");
  if (!(await saveEdits(true))) return;
  btn.disabled = true; btn.textContent = "Writing variants…";
  try { c.variants = await api(`/api/videos/${v.id}/clips/${c.id}/variants`, { method: "POST", body: { campaign: campaignSlug() || null } }); renderVariants(c); refreshVideo(v.id); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Regenerate variants";
}

async function closeDrawer() {
  if (state.editing && state.dirty && !$(".edit-col").classList.contains("hidden")) { if (await saveEdits(true)) toast("Edits saved."); }
  $("#drawer").classList.add("hidden"); const pv = $("#pv"); pv.pause(); restore("drawer");
}

boot().catch((e) => toast(e.message, true));
