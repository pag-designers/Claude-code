// Clipper web UI: plain JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const DIMS = ["hook", "story", "value", "engagement", "reach", "pacing"];

const state = { config: null, campaigns: [], video: null, transcript: null, sort: "score", selected: new Set(),
  editing: null, sel: [null, null], poll: null };

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

function toast(msg, err = false, ms = 4500) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
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

// ---------------- boot & routing ----------------
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
  $("#settings").classList.remove("hidden");
}

async function saveSettings() {
  const btn = $("#sSave"), msg = $("#sMsg");
  btn.disabled = true; msg.textContent = "Saving & checking the key…";
  try {
    applyConfig(await api("/api/settings", { method: "POST", body: { api_key: $("#sKey").value, model: $("#sModel").value, effort: $("#sEffort").value } }));
    msg.textContent = "Saved ✓"; setTimeout(() => $("#settings").classList.add("hidden"), 600);
    if (state.video) refreshVideo(state.video.id);
  } catch (e) { msg.textContent = e.message; msg.style.color = "var(--bad)"; setTimeout(() => (msg.style.color = ""), 4000); }
  btn.disabled = false;
}

async function boot() {
  applyConfig(await api("/api/config"));
  $("#keyBadge").onclick = openSettings;
  $("#settingsClose").onclick = () => $("#settings").classList.add("hidden");
  $("#settings").addEventListener("click", (e) => { if (e.target.id === "settings") $("#settings").classList.add("hidden"); });
  $("#sSave").onclick = saveSettings;
  if (!state.config.has_api_key && !localStorage.getItem("seenSettings")) { localStorage.setItem("seenSettings", "1"); setTimeout(openSettings, 400); }
  await loadCampaigns();
  $("#campaignSelect").addEventListener("change", () => { localStorage.setItem("campaign", campaignSlug()); if (state.video) renderClips(); });
  window.addEventListener("hashchange", route);
  $("#drawerClose").onclick = closeDrawer;
  $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
  route();
}

async function loadCampaigns() {
  state.campaigns = await api("/api/campaigns");
  const sel = $("#campaignSelect"), keep = sel.value || localStorage.getItem("campaign") || "";
  sel.innerHTML = `<option value="">— none —</option>` + state.campaigns.map((c) => `<option value="${esc(c.slug)}">${esc(c.campaign_name)}</option>`).join("");
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
  state.video = null; mount("#tpl-home");
  $("#urlForm").onsubmit = async (e) => {
    e.preventDefault();
    try { const job = await api("/api/videos", { method: "POST", body: { url: $("#urlInput").value } }); location.hash = `#/v/${job.video_id}`; }
    catch (err) { toast(err.message, true); }
  };
  $("#fileInput").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    $("#homeMsg").textContent = `Uploading ${f.name}…`;
    const fd = new FormData(); fd.append("file", f); fd.append("title", f.name.replace(/\.[^.]+$/, ""));
    try { const job = await api("/api/videos/upload", { method: "POST", body: fd }); location.hash = `#/v/${job.video_id}`; }
    catch (err) { $("#homeMsg").textContent = ""; toast(err.message, true); }
  };
  $("#campParse").onclick = async () => {
    const btn = $("#campParse"); btn.disabled = true; btn.textContent = "Parsing…";
    try {
      const c = await api("/api/campaigns", { method: "POST", body: { brief: $("#campBrief").value, name: $("#campName").value || null } });
      $("#campResult").innerHTML = rulesHtml(c); await loadCampaigns(); $("#campaignSelect").value = c.slug;
      localStorage.setItem("campaign", c.slug); renderCampList(); toast(`Campaign “${c.campaign_name}” saved and selected.`);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Parse rules";
  };
  renderCampList();
  const vids = await api("/api/videos");
  $("#videoList").innerHTML = vids.length ? vids.map((v) => `
    <a class="vitem" href="#/v/${esc(v.id)}"><div><div>${esc(v.title)}</div>
    <div class="muted small">${v.duration ? mmss(v.duration) : "…"} · ${esc(v.status?.message || v.status?.stage || "")}</div></div>
    <span class="badge">${esc(v.status?.stage || "")}</span></a>`).join("") : `<p class="muted small">No videos yet. Paste a URL above.</p>`;
}

function rulesHtml(c) {
  const r = [];
  if (c.min_seconds || c.max_seconds) r.push(`⏱ ${c.min_seconds || 0}–${c.max_seconds || "∞"}s`);
  if (c.language) r.push(`🗣 ${c.language}`);
  (c.must_mention || []).forEach((m) => r.push(`must mention: ${m}`));
  [...(c.required_hashtags || []), ...(c.required_tags || [])].forEach((h) => r.push(h));
  (c.required_caption_text || []).forEach((h) => r.push(`caption: “${h}”`));
  (c.banned_words || []).forEach((b) => r.push(`🚫 ${b}`));
  (c.banned_topics || []).forEach((b) => r.push(`🚫 topic: ${b}`));
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
  state.selected.clear(); state.sel = [null, null];
  $$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $("#sortBy").onchange = (e) => { state.sort = e.target.value; renderClips(); };
  $("#reclip").onclick = async () => { try { await api(`/api/videos/${id}/clip`, { method: "POST" }); toast("Re-running AI clipping…"); startPolling(id); } catch (e) { toast(e.message, true); } };
  $("#checkCamp").onclick = () => checkCampaign(id);
  $("#bulkExport").onclick = () => bulkExport(id);
  $("#momentForm").onsubmit = (e) => { e.preventDefault(); findMoments(id); };
  $("#makeClip").onclick = () => makeClipFromSelection(id);
  await refreshVideo(id);
  startPolling(id);
}

function switchTab(tab) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["clips", "moments", "transcript"].forEach((t) => $(`#tab-${t}`).classList.toggle("hidden", t !== tab));
  if (tab === "transcript") renderTranscript();
}

function startPolling(id) {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    const st = state.video?.status?.stage;
    if (["ready", "needs_key", "error"].includes(st)) return;
    await refreshVideo(id);
  }, 2000);
}

async function refreshVideo(id) {
  let v;
  try { v = await api(`/api/videos/${id}`); } catch (e) { toast(e.message, true); return; }
  const prevStage = state.video?.status?.stage;
  state.video = v;
  $("#vTitle").textContent = v.title || id;
  $("#vMeta").textContent = [v.duration && mmss(v.duration), v.width && `${v.width}×${v.height}`, v.language && `lang: ${v.language}`, v.channel].filter(Boolean).join(" · ");
  $("#vCost").textContent = `AI cost: $${(v.cost?.usd || 0).toFixed(3)}`;
  $("#vCost").title = v.cost?.by_step ? Object.entries(v.cost.by_step).map(([k, x]) => `${k}: $${x}`).join("\n") : "";
  const st = v.status || {}, prog = $("#vProgress");
  const busy = !["ready", "needs_key", "error"].includes(st.stage) && st.stage;
  prog.classList.toggle("hidden", !busy && st.stage !== "error" && st.stage !== "needs_key");
  $(".bar span", prog).style.width = `${Math.round((st.progress || 0) * 100)}%`;
  $(".msg", prog).textContent = st.error ? `Error: ${st.error}` : st.message || st.stage || "";
  $(".msg", prog).style.color = st.error ? "var(--bad)" : "";
  if (st.stage === "needs_key") $(".bar", prog).classList.add("hidden");
  if (prevStage !== st.stage && (st.stage === "ready" || st.stage === "needs_key")) state.transcript = null;
  renderClips();
}

function compliance(c) { const s = campaignSlug(); return s && c.checks?.[s]; }

function renderClips() {
  const v = state.video; if (!v || !$("#clips")) return;
  let clips = [...(v.clips || [])];
  if (state.sort === "time") clips.sort((a, b) => a.start - b.start);
  else if (state.sort === "compliance") { const o = { pass: 0, warn: 1, fail: 2 }; clips.sort((a, b) => (o[compliance(a)?.after_fixes] ?? 3) - (o[compliance(b)?.after_fixes] ?? 3) || (b.score ?? 0) - (a.score ?? 0)); }
  else clips.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  $("#clipCount").textContent = clips.length ? `${clips.length} clips` : (v.status?.stage === "needs_key" ? "Transcript ready. Add your API key in Settings (⚙ top right), then press “Re-run AI clipping”. You can already make clips from the Transcript tab." : "No clips yet.");
  $("#clips").innerHTML = clips.map((c) => {
    const comp = compliance(c), dur = c.edited_duration ?? c.duration;
    return `<article class="card" data-id="${c.id}">
      <div class="card-top">
        ${c.score != null ? `<div class="ring" style="--p:${c.score};--c:${scoreColor(c.score)}"><b>${c.score}</b></div>` : `<div class="ring"><b>–</b></div>`}
        <div><h4>${esc(c.title)}</h4>
        <span class="tag cat-${esc(c.category)}">${esc(c.category)}</span><span class="muted small">${dur.toFixed(1)}s · ${mmss(c.start)}–${mmss(c.end)}</span></div>
      </div>
      ${c.hook_text ? `<div class="hookline">🪝 ${esc(c.hook_text)}</div>` : ""}
      ${c.dims ? `<div class="dims">${DIMS.map((d) => `<div class="dim" title="${esc(c.dims[d].reason)}\nFix: ${esc(c.dims[d].fix)}">${d} ${c.dims[d].score}<div class="b"><span style="width:${c.dims[d].score}%"></span></div></div>`).join("")}</div>` : ""}
      ${c.verdict ? `<div class="verdict">${esc(c.verdict)}</div>` : `<div class="muted small">${esc(c.why || "")}</div>`}
      <div class="card-actions">
        <label class="pick"><input type="checkbox" data-pick="${c.id}" ${state.selected.has(c.id) ? "checked" : ""}> export</label>
        ${comp ? `<span class="comp ${comp.after_fixes}" title="Now: ${comp.status}. After auto-fixes: ${comp.after_fixes}">rules: ${comp.after_fixes}${comp.status !== comp.after_fixes ? " (after fixes)" : ""}</span>` : ""}
        <button class="primary small-btn" data-edit="${c.id}">Preview & edit</button>
      </div></article>`;
  }).join("");
  $$("[data-edit]").forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  $$("[data-pick]").forEach((b) => (b.onchange = () => { b.checked ? state.selected.add(b.dataset.pick) : state.selected.delete(b.dataset.pick); updateBulk(); }));
  updateBulk();
}

function updateBulk() {
  const n = state.selected.size;
  $("#bulkBar")?.classList.toggle("hidden", n === 0);
  if ($("#bulkCount")) $("#bulkCount").textContent = `${n} selected${campaignSlug() ? " · campaign: " + $("#campaignSelect").selectedOptions[0].text : ""}`;
}

async function checkCampaign(id) {
  const slug = campaignSlug();
  if (!slug) return toast("Pick (or create) a campaign at the top first.", true);
  const btn = $("#checkCamp"); btn.disabled = true; btn.textContent = "Checking…";
  try { await waitJob(await api(`/api/videos/${id}/check/${slug}`, { method: "POST" })); await refreshVideo(id); state.sort = "compliance"; $("#sortBy").value = "compliance"; renderClips(); toast("Campaign check done."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Check campaign rules";
}

async function bulkExport(id) {
  const ids = [...state.selected], btn = $("#bulkExport");
  btn.disabled = true;
  try {
    const job = await api(`/api/videos/${id}/export`, { method: "POST", body: { clip_ids: ids, campaign: campaignSlug() || null, variants: +$("#bulkVariants").value } });
    const res = await waitJob(job, (j) => (btn.textContent = `Exporting… ${Math.round(j.progress * 100)}%`));
    const links = res.exports.map((e) => `${e.folder}\n  ` + e.files.join(", ")).join("\n");
    toast(`Exported ${res.exports.length} clip(s) to:\n${links}`, false, 15000);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Export selected";
}

// ---------------- find moments ----------------
async function findMoments(id) {
  const q = $("#momentQuery").value, box = $("#moments");
  box.innerHTML = `<p class="muted">Searching…</p>`;
  try {
    const res = await api(`/api/videos/${id}/moments`, { method: "POST", body: { query: q } });
    box.innerHTML = res.length ? res.map((m, i) => `<div class="moment">
      <div class="score" style="color:${scoreColor(m.match_score)}">${m.match_score}</div>
      <div><b>${esc(m.title)}</b> <span class="muted small">${mmss(m.start)}–${mmss(m.end)} · ${m.duration.toFixed(1)}s</span><br><q>${esc(m.quote)}</q><div class="small">${esc(m.why)}</div></div>
      <div class="acts"><button class="ghost small-btn" data-play="${i}">▶ Source</button><button class="primary small-btn" data-add="${i}">Add as clip</button></div></div>`).join("") : `<p class="muted">Nothing matched. Try a broader search.</p>`;
    $$("[data-add]", box).forEach((b) => (b.onclick = async () => {
      const m = res[+b.dataset.add];
      try { await api(`/api/videos/${id}/clips`, { method: "POST", body: { start_sentence: m.start_sentence, end_sentence: m.end_sentence, title: m.title, why: `Find Moments: ${m.why}` } }); b.textContent = "Added ✓"; b.disabled = true; refreshVideo(id); } catch (e) { toast(e.message, true); }
    }));
    $$("[data-play]", box).forEach((b) => (b.onclick = () => { const m = res[+b.dataset.play]; openSourcePlayer(id, m.start, m.end); }));
  } catch (e) { box.innerHTML = ""; toast(e.message, true); }
}

function openSourcePlayer(id, start, end) {
  // Lightweight: reuse the editor phone for a 16:9 source preview.
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
  box.innerHTML = t.sentences.map((s) => `<div class="sent" data-i="${s.i}"><span class="t">${mmss(s.s)}</span><span class="s">S${s.spk || 1}</span><span>${esc(s.text)}</span></div>`).join("");
  $$(".sent", box).forEach((el) => (el.onclick = (e) => {
    const i = +el.dataset.i;
    if (e.shiftKey && state.sel[0] != null) state.sel[1] = i; else state.sel = [i, i];
    const [a, b] = [Math.min(...state.sel), Math.max(...state.sel)];
    $$(".sent", box).forEach((x) => x.classList.toggle("sel", +x.dataset.i >= a && +x.dataset.i <= b));
    const d = t.sentences[b].e - t.sentences[a].s;
    $("#selInfo").textContent = `Selected #${a}–#${b} · ${d.toFixed(1)}s`;
    $("#makeClip").disabled = false;
  }));
}

async function makeClipFromSelection(id) {
  const [a, b] = [Math.min(...state.sel), Math.max(...state.sel)];
  const t = await loadTranscript();
  const title = t.sentences[a].text.split(" ").slice(0, 8).join(" ");
  try { const c = await api(`/api/videos/${id}/clips`, { method: "POST", body: { start_sentence: a, end_sentence: b, title } }); toast(`Clip ${c.id} added.`); await refreshVideo(id); switchTab("clips"); }
  catch (e) { toast(e.message, true); }
}

// ---------------- editor ----------------
async function openEditor(clipId) {
  const v = state.video, c = v.clips.find((x) => x.id === clipId); if (!c) return;
  const t = await loadTranscript();
  state.editing = { clip: c, removed: new Set(c.removed_words || []), style: c.style || "bold-pop", layout: c.layout || "auto" };
  $("#drawer").classList.remove("hidden"); $(".edit-col").classList.remove("hidden");
  $("#eTitle").value = c.title; $("#eHook").value = c.hook_text || "";
  $("#eMeta").textContent = `${c.category} · ${mmss(c.start)}–${mmss(c.end)} · ${c.why || ""}`;
  $("#eScore").innerHTML = c.dims ? `<div class="checks">${DIMS.map((d) => `<div class="check"><span style="color:${scoreColor(c.dims[d].score)}">${c.dims[d].score}</span><div><b>${d}</b>: ${esc(c.dims[d].reason)}<div class="d">Fix: ${esc(c.dims[d].fix)}</div></div></div>`).join("")}</div>` : "";
  $("#eStyles").innerHTML = Object.entries(state.config.caption_styles).map(([k, l]) => `<button class="chip ${k === state.editing.style ? "on" : ""}" data-style="${k}">${esc(l)}</button>`).join("");
  $("#eLayouts").innerHTML = state.config.layouts.map((k) => `<button class="chip ${k === state.editing.layout ? "on" : ""}" data-layout="${k}">${k}</button>`).join("");
  $$("[data-style]").forEach((b) => (b.onclick = () => { state.editing.style = b.dataset.style; $$("[data-style]").forEach((x) => x.classList.toggle("on", x === b)); }));
  $$("[data-layout]").forEach((b) => (b.onclick = () => { state.editing.layout = b.dataset.layout; $$("[data-layout]").forEach((x) => x.classList.toggle("on", x === b)); }));
  renderWords(t);
  renderChecks(c);
  renderVariants(c);
  $("#pvMsg").textContent = "";
  playRange($("#pv"), `/media/${v.id}/source.mp4`, c.start, c.end);
  $("#playSource").onclick = () => playRange($("#pv"), `/media/${v.id}/source.mp4`, state.editing.clip.start, state.editing.clip.end);
  $("#renderPreview").onclick = () => renderPreview();
  $("#eSave").onclick = () => saveEdits();
  $("#eRestore").onclick = () => { state.editing.removed.clear(); renderWords(t); };
  $("#eDelete").onclick = async () => { if (!confirm("Delete this clip?")) return; await api(`/api/videos/${v.id}/clips/${c.id}`, { method: "DELETE" }); closeDrawer(); refreshVideo(v.id); };
  $("#eVariants").onclick = () => makeVariants();
  $$("[data-nudge]").forEach((b) => (b.onclick = () => nudge(...b.dataset.nudge.split(","))));
}

function renderWords(t) {
  const c = state.editing.clip, box = $("#eWords");
  const words = t.words.slice(c.w0, c.w1 + 1);
  box.innerHTML = words.map((w) => `<span class="w ${state.editing.removed.has(w.i) ? "cut" : ""}" data-w="${w.i}">${esc(w.w)}</span>`).join(" ");
  $$(".w", box).forEach((el) => (el.onclick = () => { const i = +el.dataset.w; state.editing.removed.has(i) ? state.editing.removed.delete(i) : state.editing.removed.add(i); el.classList.toggle("cut"); updateDur(t); }));
  updateDur(t);
}

function updateDur(t) {
  const c = state.editing.clip;
  const cut = t.words.slice(c.w0, c.w1 + 1).filter((w) => state.editing.removed.has(w.i)).reduce((s, w) => s + (w.e - w.s), 0);
  $("#eDur").textContent = `≈ ${(c.end - c.start - cut).toFixed(1)}s after cuts`;
}

async function saveEdits(silent = false) {
  const v = state.video, e = state.editing;
  const body = { title: $("#eTitle").value, hook_text: $("#eHook").value, style: e.style, layout: e.layout, removed_words: [...e.removed] };
  try { const c = await api(`/api/videos/${v.id}/clips/${e.clip.id}`, { method: "PATCH", body }); Object.assign(e.clip, c); if (!silent) toast("Saved."); await refreshVideo(v.id); return true; }
  catch (err) { toast(err.message, true); return false; }
}

async function nudge(edge, delta) {
  const v = state.video, c = state.editing.clip;
  const body = edge === "start" ? { start_sentence: c.start_sentence + +delta } : { end_sentence: c.end_sentence + +delta };
  try { const nc = await api(`/api/videos/${v.id}/clips/${c.id}`, { method: "PATCH", body }); Object.assign(c, nc); renderWords(await loadTranscript()); $("#eMeta").textContent = `${c.category} · ${mmss(c.start)}–${mmss(c.end)}`; playRange($("#pv"), `/media/${v.id}/source.mp4`, c.start, c.end); refreshVideo(v.id); }
  catch (e) { toast(e.message, true); }
}

async function renderPreview(variant = null) {
  if (!variant && !(await saveEdits(true))) return;
  const v = state.video, c = state.editing.clip, msg = $("#pvMsg");
  msg.textContent = "Rendering preview…";
  try {
    const job = await api(`/api/videos/${v.id}/clips/${c.id}/preview`, { method: "POST", body: { variant } });
    const res = await waitJob(job, (j) => (msg.textContent = j.status === "queued" ? "Queued…" : "Rendering preview…"));
    const pv = $("#pv"); pv.ontimeupdate = null; pv.src = res.url; pv.play().catch(() => {});
    msg.textContent = variant ? `Variant ${variant} preview (low-res)` : "9:16 preview (low-res; export renders full 1080×1920)";
  } catch (e) { msg.textContent = ""; toast(e.message, true); }
}

function renderChecks(c) {
  const comp = compliance(c), box = $("#eChecks");
  if (!comp) { box.innerHTML = `<span class="muted small">${campaignSlug() ? "Press “Check campaign rules” on the clips page." : "Pick a campaign at the top, then press “Check campaign rules”."}</span>`; return; }
  const icon = { pass: "✅", fail: "❌", warn: "⚠️" };
  box.innerHTML = `<div class="checks">${comp.rows.map((r) => `<div class="check"><span>${icon[r.status]}</span><div>${esc(r.rule)} <span class="d">${esc(r.detail)} · ${r.by}</span></div></div>`).join("")}</div>`
    + (comp.fixes.length ? `<p class="small">Auto-fixes applied at export:<br>${comp.fixes.map((f) => "• " + esc(f)).join("<br>")}</p>` : "")
    + `<p class="small muted">Hashtags, tags and caption text are added to every platform caption automatically at export.</p>`;
}

function renderVariants(c) {
  const box = $("#eVariantList");
  if (!c.variants) { box.innerHTML = ""; return; }
  const names = { tiktok: "TikTok", youtube_shorts: "Shorts", instagram_reels: "Reels", x: "X" };
  box.innerHTML = c.variants.map((v) => `<div class="variant">
    <b>Variant ${v.n}</b><span class="muted small">${esc(v.angle)} · ${esc(v.plan.style)} · zoom ${v.plan.zoom} · ${v.plan.speed}x · ${esc(v.plan.layout)}${v.clip_patch?.start ? " · new cut" : ""}</span>
    <div class="hookline">🪝 ${esc(v.hook_text)}</div>
    ${Object.entries(v.posts).map(([p, post]) => `<div class="post"><b>${names[p] || p}</b>${post.title ? `<div>${esc(post.title)}</div>` : ""}<div class="muted">${esc(post.caption)} ${esc(post.hashtags.join(" "))}</div></div>`).join("")}
    <button class="ghost small-btn" data-vprev="${v.n}">Preview variant</button></div>`).join("");
  $$("[data-vprev]", box).forEach((b) => (b.onclick = () => renderPreview(+b.dataset.vprev)));
}

async function makeVariants() {
  const v = state.video, c = state.editing.clip, btn = $("#eVariants");
  if (!(await saveEdits(true))) return;
  btn.disabled = true; btn.textContent = "Writing variants…";
  try { c.variants = await api(`/api/videos/${v.id}/clips/${c.id}/variants`, { method: "POST", body: { campaign: campaignSlug() || null } }); renderVariants(c); refreshVideo(v.id); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = "Regenerate variants";
}

function closeDrawer() {
  $("#drawer").classList.add("hidden"); const pv = $("#pv"); pv.pause();
}

boot().catch((e) => toast(e.message, true));
