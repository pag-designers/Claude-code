// Clipper web UI: plain JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const DIMS = ["hook", "story", "value", "engagement", "reach", "pacing"];
const STAGE = { queued: "Queued", download: "Downloading", audio: "Preparing", transcribe: "Transcribing", cues: "Analyzing",
  clipping: "Finding clips", scoring: "Scoring", ready: "Ready", needs_key: "Needs API key", error: "Failed" };
const LANG = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian" };
const PLATFORM = { tiktok: "TikTok", youtube_shorts: "Shorts", instagram_reels: "Reels", x: "X" };

const state = { config: null, campaigns: [], video: null, transcript: null, sort: "score", selected: new Set(),
  editing: null, dirty: false, sel: [null, null], poll: null, eta: null };

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
  kb.textContent = c.has_api_key ? `⚙ AI: ${c.model.replace("claude-", "")}` : "⚙ AI off: add API key";
  kb.className = "badge " + (c.has_api_key ? "ok" : "bad");
}

function openSettings() {
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
    msg.textContent = "Saved ✓"; setTimeout(() => $("#settings").classList.add("hidden"), 600);
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
  $("#settingsClose").onclick = () => $("#settings").classList.add("hidden");
  $("#settings").addEventListener("click", (e) => { if (e.target.id === "settings") $("#settings").classList.add("hidden"); });
  $("#sSave").onclick = saveSettings;
  if (!state.config.has_api_key) setTimeout(openSettings, 400);   // no key yet: the AI can't work, so ask right away
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
  const m = location.hash.match(/^#\/v\/(.+)$/);
  m ? showVideo(decodeURIComponent(m[1])) : showHome();
}

function mount(tplId) {
  const app = $("#app"); app.innerHTML = ""; app.append($(tplId).content.cloneNode(true));
}

// ---------------- home ----------------
async function showHome() {
  state.video = null; document.title = "Clipper"; mount("#tpl-home");
  $("#urlForm").onsubmit = async (e) => {
    e.preventDefault(); askNotify();
    const b = $("#urlForm .primary"); b.disabled = true; b.textContent = "Starting…";
    try { const job = await api("/api/videos", { method: "POST", body: { url: $("#urlInput").value.trim() } }); location.hash = `#/v/${job.video_id}`; }
    catch (err) { toast(err.message, true); b.disabled = false; b.textContent = "Find clips"; }
  };
  $("#uploadBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = (e) => e.target.files[0] && uploadFile(e.target.files[0]);
  const hero = $(".hero");
  hero.ondragover = (e) => { e.preventDefault(); hero.classList.add("drop"); };
  hero.ondragleave = () => hero.classList.remove("drop");
  hero.ondrop = (e) => { e.preventDefault(); hero.classList.remove("drop"); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); };
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
  let vids;
  try { vids = await api("/api/videos"); }
  catch (e) { $("#videoList").innerHTML = `<p class="small" style="color:var(--bad)">Couldn't load your videos: ${esc(e.message)}</p>`; return; }
  $("#videoList").innerHTML = vids.length ? vids.map((v) => {
    const st = v.status?.stage;
    return `<a class="vitem" href="#/v/${esc(v.id)}"><div><div>${esc(v.title)}</div>
      <div class="muted small">${v.duration ? mmss(v.duration) : "…"}${isBusy(st) && v.status?.message ? " · " + esc(v.status.message) : ""}</div></div>
      <span class="badge ${st === "ready" ? "ok" : st === "error" ? "err" : ""}">${STAGE[st] || ""}</span></a>`;
  }).join("") : `<p class="muted small">No videos yet. Paste a URL above.</p>`;
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
  el.innerHTML = state.campaigns.map((c) => `<div class="vitem" style="flex-direction:column"><b>${esc(c.campaign_name)}</b>${rulesHtml(c)}</div>`).join("");
}

// ---------------- video page ----------------
async function showVideo(id) {
  mount("#tpl-video");
  state.selected.clear(); state.sel = [null, null]; state.eta = null; state.transcript = null; renderClips._sig = null;
  $$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $("#sortBy").onchange = (e) => { state.sort = e.target.value; renderClips(true); };
  $("#reclip").onclick = () => startReclip(id, true);
  $("#checkCamp").onclick = () => checkCampaign(id);
  $("#bulkExport").onclick = () => bulkExport(id);
  $("#selectAll").onclick = () => {
    const ids = (state.video?.clips || []).map((c) => c.id), all = ids.length && ids.every((i) => state.selected.has(i));
    ids.forEach((i) => (all ? state.selected.delete(i) : state.selected.add(i))); renderClips(true);
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
    if (state.video) state.video.status = { stage: "queued", progress: 0 };   // so polling resumes immediately
    state.eta = null; toast("Finding clips…"); startPolling(id); refreshVideo(id);
  }
  catch (e) { toast(e.message, true); }
}

function switchTab(tab) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
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
  try { v = await api(`/api/videos/${id}`); } catch (e) { toast(e.message, true); return; }
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

function renderClips(force = false) {
  const v = state.video; if (!v || !$("#clips")) return;
  let clips = [...(v.clips || [])];
  if (state.sort === "time") clips.sort((a, b) => a.start - b.start);
  else if (state.sort === "compliance") { const o = { pass: 0, warn: 1, fail: 2 }; clips.sort((a, b) => (o[compliance(a)?.after_fixes] ?? 3) - (o[compliance(b)?.after_fixes] ?? 3) || (b.score ?? 0) - (a.score ?? 0)); }
  else clips.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  // Polling refreshes every 2 s: only redraw when something visible changed.
  const sig = JSON.stringify([clips, state.sort, campaignSlug(), [...state.selected], v.status?.stage]);
  if (!force && sig === renderClips._sig && $("#clips").childElementCount) return;
  renderClips._sig = sig;
  if (!clips.length && isBusy(v.status?.stage)) {
    $("#clipCount").textContent = "Clips will appear here when processing finishes.";
    $("#clips").innerHTML = Array(6).fill(`<div class="card skel" aria-hidden="true"><div class="sk sk-thumb"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>`).join("");
    updateBulk(); return;
  }
  $("#clipCount").textContent = clips.length ? `${clips.length} clip${clips.length > 1 ? "s" : ""}` : (v.status?.stage === "needs_key" ? "No AI clips yet. You can make clips by hand in the Transcript tab." : "No clips yet.");
  $("#clips").innerHTML = clips.map((c) => {
    const comp = compliance(c), dur = c.edited_duration ?? c.duration;
    return `<article class="card" data-id="${c.id}">
      <div class="thumb" data-thumb="${c.id}" role="button" tabindex="0" aria-label="Edit ${esc(c.title)}">
        <img src="/api/videos/${encodeURIComponent(v.id)}/clips/${encodeURIComponent(c.id)}/thumb.jpg?t=${c.start}" alt="" loading="lazy" onerror="this.remove()">
        <span class="dur">${Math.round(dur)}s</span>
      </div>
      <div class="card-top">
        ${c.score != null ? `<div class="ring" style="--p:${c.score};--c:${scoreColor(c.score)}" title="Viral score"><b>${c.score}</b></div>` : `<div class="ring" title="Not scored"><b>–</b></div>`}
        <div><h4>${esc(c.title)}</h4>
        <span class="tag cat-${esc(c.category)}">${esc(c.category)}</span><span class="muted small">${mmss(c.start)}–${mmss(c.end)}</span></div>
      </div>
      ${c.hook_text ? `<div class="hookline"><span class="hook-lbl">HOOK</span>${esc(c.hook_text)}</div>` : ""}
      ${c.dims ? `<div class="dims">${DIMS.map((d) => `<div class="dim" title="${esc(c.dims[d].reason)}\nFix: ${esc(c.dims[d].fix)}">${d} ${c.dims[d].score}<div class="b"><span style="width:${c.dims[d].score}%;background:${scoreColor(c.dims[d].score)}"></span></div></div>`).join("")}</div>` : ""}
      ${c.verdict ? `<div class="verdict">${esc(c.verdict)}</div>` : `<div class="muted small">${esc(c.why || "")}</div>`}
      <div class="card-actions">
        <label class="pick"><input type="checkbox" data-pick="${c.id}" ${state.selected.has(c.id) ? "checked" : ""}> Select</label>
        ${comp ? `<span class="comp ${comp.after_fixes}" title="As-is: ${comp.status}. After auto-fixes at export: ${comp.after_fixes}">${compLabel(comp)}</span>` : ""}
        <button class="ghost small-btn" data-edit="${c.id}">Edit</button>
      </div></article>`;
  }).join("");
  $$("[data-edit]").forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  $$(".thumb").forEach((el) => {
    el.onclick = () => openEditor(el.dataset.thumb);
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEditor(el.dataset.thumb); } };
  });
  $$("[data-pick]").forEach((b) => (b.onchange = () => { b.checked ? state.selected.add(b.dataset.pick) : state.selected.delete(b.dataset.pick); updateBulk(); b.closest(".card").classList.toggle("picked", b.checked); }));
  $$("[data-pick]:checked").forEach((b) => b.closest(".card").classList.add("picked"));
  updateBulk();
}

function updateBulk() {
  const n = state.selected.size;
  $("#bulkBar")?.classList.toggle("hidden", n === 0);
  if ($("#bulkCount")) $("#bulkCount").textContent = `${n} selected${campaignSlug() ? " · campaign: " + $("#campaignSelect").selectedOptions[0].text : ""}`;
  if ($("#selectAll")) { const ids = (state.video?.clips || []).map((c) => c.id); $("#selectAll").textContent = ids.length && ids.every((i) => state.selected.has(i)) ? "Select none" : "Select all"; }
}

async function checkCampaign(id) {
  const slug = campaignSlug();
  if (!slug) return toast("Pick (or create) a campaign at the top first.", true);
  const btn = $("#checkCamp"); btn.disabled = true; btn.textContent = "Checking…";
  try { await waitJob(await api(`/api/videos/${id}/check/${slug}`, { method: "POST" })); await refreshVideo(id); state.sort = "compliance"; $("#sortBy").value = "compliance"; renderClips(true); toast("Campaign check done."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Check campaign rules";
}

async function bulkExport(id) {
  const ids = [...state.selected], btn = $("#bulkExport");
  btn.disabled = true;
  try {
    const job = await api(`/api/videos/${id}/export`, { method: "POST", body: { clip_ids: ids, campaign: campaignSlug() || null, variants: +$("#bulkVariants").value } });
    const res = await waitJob(job, (j) => (btn.textContent = `Exporting… ${Math.round(j.progress * 100)}%`));
    const items = res.exports.map((e) => `<div class="exp"><b>${esc(e.folder.split("/").pop())}</b><div>${e.files.map((f) => `<a href="/${e.folder.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(f)}" target="_blank" rel="noopener">${esc(f)}</a>`).join(" · ")}</div></div>`).join("");
    const where = res.exports[0]?.folder.split("/").slice(0, -1).join("/") || "output";
    toast(`<b>Exported ${res.exports.length} clip${res.exports.length > 1 ? "s" : ""} ✓</b><div class="muted small">Saved in your Clipper folder → ${esc(where.replace(/\//g, " → "))}</div>${items}<button class="primary small-btn open-folder" id="openFolder">Open folder</button>`, false, 0, true);
    $("#openFolder").onclick = () => api("/api/open-folder", { method: "POST", body: { folder: res.exports.length > 1 ? where : res.exports[0].folder } }).catch((e) => toast(e.message, true));
    signalDone(`Exported ${res.exports.length} clip${res.exports.length > 1 ? "s" : ""}`, "");
    state.selected.clear(); renderClips(true);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Export selected";
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
      <div class="acts"><button class="ghost small-btn" data-play="${i}">▶ Play</button><button class="primary small-btn" data-add="${i}">Add as clip</button></div></div>`).join("") : `<p class="muted">Nothing matched. Try a broader search.</p>`;
    $$("[data-add]", box).forEach((b) => (b.onclick = async () => {
      const m = res[+b.dataset.add];
      try { await api(`/api/videos/${id}/clips`, { method: "POST", body: { start_sentence: m.start_sentence, end_sentence: m.end_sentence, title: m.title, why: `Find Moments: ${m.why}` } }); b.textContent = "Added ✓"; b.disabled = true; refreshVideo(id); } catch (e) { toast(e.message, true); }
    }));
    $$("[data-play]", box).forEach((b) => (b.onclick = () => { const m = res[+b.dataset.play]; openSourcePlayer(id, m.start, m.end); }));
  } catch (e) {
    box.innerHTML = /API key/i.test(e.message) ? `<div class="callout"><div>Find Moments needs the AI. Add your API key first.</div><button class="primary" id="mKey">Add API key</button></div>` : `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`;
    $("#mKey")?.addEventListener("click", openSettings);
  }
}

function openSourcePlayer(id, start, end) {
  state.editing = null;
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
async function openEditor(clipId) {
  const v = state.video, c = v.clips.find((x) => x.id === clipId); if (!c) return;
  const t = await loadTranscript();
  state.editing = { clip: c, removed: new Set(c.removed_words || []), style: c.style || "bold-pop", layout: c.layout || "auto" };
  state.dirty = false;
  $("#drawer").classList.remove("hidden"); $(".edit-col").classList.remove("hidden");
  $("#eTitle").value = c.title; $("#eHook").value = c.hook_text || "";
  $("#eTitle").oninput = $("#eHook").oninput = () => (state.dirty = true);
  $("#eMeta").textContent = `${c.category} · ${mmss(c.start)}–${mmss(c.end)}${c.why ? " · " + c.why : ""}`;
  $("#eScore").innerHTML = c.dims ? `<details class="why"><summary><span class="ring sm" style="--p:${c.score};--c:${scoreColor(c.score)}"><b>${c.score}</b></span><span>${esc(c.verdict || "Viral score")}</span><span class="muted small">Why this score?</span></summary><div class="checks">${DIMS.map((d) => `<div class="check"><span style="color:${scoreColor(c.dims[d].score)}">${c.dims[d].score}</span><div><b>${d}</b>: ${esc(c.dims[d].reason)}<div class="d">Fix: ${esc(c.dims[d].fix)}</div></div></div>`).join("")}</div></details>` : "";
  $("#eStyles").innerHTML = Object.entries(state.config.caption_styles).map(([k, l]) => `<button class="chip ${k === state.editing.style ? "on" : ""}" data-style="${k}">${esc(l)}</button>`).join("");
  $("#eLayouts").innerHTML = state.config.layouts.map((k) => `<button class="chip ${k === state.editing.layout ? "on" : ""}" data-layout="${k}">${k}</button>`).join("");
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
}

function renderWords(t) {
  const c = state.editing.clip, box = $("#eWords");
  const words = t.words.slice(c.w0, c.w1 + 1);
  box.innerHTML = words.map((w) => `<span class="w ${state.editing.removed.has(w.i) ? "cut" : ""}" data-w="${w.i}">${esc(w.w)}</span>`).join(" ");
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
  if (e.key === "Escape" && !$("#settings").classList.contains("hidden")) return $("#settings").classList.add("hidden");
  if ($("#drawer").classList.contains("hidden")) return;
  if (e.key === "Escape") return closeDrawer();
  if (!state.editing) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); return saveEdits(); }
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
  box.innerHTML = c.variants.map((v) => `<div class="variant">
    <b>Variant ${v.n}</b><span class="muted small">${esc(v.angle)} · ${esc(v.plan.style)} · zoom ${v.plan.zoom} · ${v.plan.speed}x · ${esc(v.plan.layout)}${v.clip_patch?.start ? " · new cut" : ""}</span>
    <div class="hookline"><span class="hook-lbl">HOOK</span>${esc(v.hook_text)}</div>
    ${Object.entries(v.posts).map(([p, post]) => { const txt = `${post.caption} ${post.hashtags.join(" ")}`.trim(); return `<div class="post">
      <div class="post-h"><b>${PLATFORM[p] || p}</b><button class="ghost copy" data-copy="${esc(txt)}" aria-label="Copy ${PLATFORM[p] || p} caption">Copy</button></div>
      ${post.title ? `<div class="post-title">${esc(post.title)} <button class="ghost copy" data-copy="${esc(post.title)}" aria-label="Copy title">Copy title</button></div>` : ""}
      <div class="muted">${esc(txt)}</div></div>`; }).join("")}
    <button class="primary small-btn" data-vprev="${v.n}">Preview variant</button></div>`).join("");
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
  $("#drawer").classList.add("hidden"); const pv = $("#pv"); pv.pause();
}

boot().catch((e) => toast(e.message, true));
