// Kurgu Atölyesi panel UI (Claude Design "Kurgu Atolyesi v2.dc.html"). Everything shown comes from /api/state;
// nothing is simulated. Two areas: home (Projeler, Marka) and the workspace (Döküm → Plan → Render → Teslim).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "@remotion/player";
import { GraphicsLayer } from "../src/compositions/GraphicsLayer";
import { planSchema } from "../src/plan/schema";
import { MontageStage } from "./timeline/MontageStage.jsx";
import { PrivacyStage } from "./PrivacyStage.jsx";

const CHOICES = [
  ["profil", "Renk profili", [["Normal", "Normal"], ["D-Log M + LUT", "D-Log M, LUT uygulandı"], ["D-Log M", "D-Log M, LUT yok"], ["Karışık", "Karışık"]]],
  ["tempo", "Tempo", [["Sade", "Sade"], ["Dengeli", "Dengeli"], ["Yoğun", "Yoğun"]]],
  ["sfx", "Ses efekti", [["Hiç", "Hiç"], ["Hafif", "Hafif"], ["Belirgin", "Belirgin"]]],
  ["muzik", "Müzik", [["Dosya verdim", "Dosya verdim"], ["Yok", "Müzik yok"]]],
  ["hook", "Açılış", [["Yok", "Yok"], ["Var", "Var"]]],
  ["kapanis", "Kapanış kartı", [["Yok", "Yok"], ["Var", "Var"]]],
  ["abone", "Abone kartı", [["Yok", "Yok"], ["Var", "Var"]]],
];
const DEFAULT_CHOICES = { profil: "Normal", tempo: "Dengeli", sfx: "Hafif", muzik: "Müzik yok", hook: "Yok", kapanis: "Yok", abone: "Yok" };
const STAGES = [["montaj", "Montaj"], ["desifre", "Döküm"], ["plan", "Plan"], ["gizlilik", "Gizlilik"], ["render", "Render"], ["teslim", "Teslim"]];
const EVENT_NAMES = { callout: "Bilgi kutusu" };
const OUT_ICONS = { "final-hlg.mov": "icon-film", "final-hlg.temiz-ses.mov": "icon-film", "final.tr.srt": "icon-captions", stems: "icon-audio-lines", "README.tr.md": "icon-file-text" };
const JOB_STEP = { master: "Grafik ve birleştirme", qc: "Video kontrolü", audio: "Ses", qcmix: "Miks kontrolü" };

const pad = (n) => String(n).padStart(2, "0");
const short = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const dec = (n) => String(n).replace(".", ",");
const mb = (n) => (n == null ? "" : n > 1e6 ? ` · ${Math.round(n / 1e6)} MB` : ` · ${Math.max(1, Math.round(n / 1e3))} KB`);
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Sunucu hatası (${r.status})`);
  return data;
};
const niceTicks = (T) => {
  const step = [1, 2, 5, 10, 30, 60, 120, 300, 600].find((x) => T / x <= 17) ?? 1200;
  return Array.from({ length: Math.floor(T / step) + 1 }, (_, i) => ({ at: i * step, major: i % 2 === 0 }));
};
// uncertain passages may span a subtitle boundary, so they are located on the joined text
const markSegments = (segments, uncertain) => {
  const joined = segments.map((s) => s.text).join(" ");
  const ranges = uncertain.map((u) => { const i = joined.indexOf(u.text); return i < 0 ? null : [i, i + u.text.length]; }).filter(Boolean);
  let offset = 0;
  return segments.map((s) => {
    const from = offset, to = offset + s.text.length;
    offset = to + 1;
    const parts = [];
    let pos = from;
    for (const [a, b] of ranges.filter(([a, b]) => a < to && b > from).sort((x, y) => x[0] - y[0])) {
      const start = Math.max(a, from), end = Math.min(b, to);
      if (start > pos) parts.push([joined.slice(pos, start), false]);
      parts.push([joined.slice(start, end), true]);
      pos = end;
    }
    if (pos < to) parts.push([joined.slice(pos, to), false]);
    return { ...s, parts };
  });
};
// greedy lane per event (1-based): overlapping graphics must stay reachable on the timeline
const laneOf = (events) => {
  const ends = [];
  return events.map((e) => {
    let lane = ends.findIndex((end) => end <= e.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = e.end;
    return lane + 1;
  });
};
const eventTitle = (e) => e.content?.headline ?? e.content?.title ?? e.content?.label ?? e.content?.text ?? e.type;
const Inline = ({ text }) => text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).map((x, i) => {
  if (x.startsWith("**") && x.endsWith("**") && x.length > 4) return <strong key={i} style={{ fontWeight: 600 }}>{x.slice(2, -2)}</strong>;
  if (x.startsWith("`") && x.endsWith("`") && x.length > 2) return <code key={i} className="mono" style={{ fontSize: 12 }}>{x.slice(1, -1)}</code>;
  return <span key={i}>{x}</span>;
});
// one column per device pixel: the bucket range it covers, min to max, with RMS as the solid core.
// Height is dBFS (−48 at the centre line, 0 at the edge), the same scale on every track.
const FLOOR_DB = 48;
const toHeight = (v) => (v > 0 ? Math.max(0, (20 * Math.log10(v) + FLOOR_DB) / FLOOR_DB) : 0);
const Waveform = ({ track, colors }) => {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !track) return undefined;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (!w || !h) return;
      canvas.width = w; canvas.height = h;
      const c = canvas.getContext("2d"), mid = h / 2, n = track.max.length;
      c.clearRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x * n) / w), b = Math.max(a + 1, Math.floor(((x + 1) * n) / w));
        let lo = 0, hi = 0, rms = 0;
        for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, track.min[i]); hi = Math.max(hi, track.max[i]); rms = Math.max(rms, track.rms[i]); }
        c.fillStyle = colors.peak;
        const up = toHeight(hi), down = toHeight(-lo), core = toHeight(rms);
        c.fillRect(x, mid - up * mid, 1, Math.max(1, (up + down) * mid));
        c.fillStyle = colors.rms;
        c.fillRect(x, mid - core * mid, 1, core * 2 * mid);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [track, colors]);
  return <canvas ref={ref} aria-label={track ? `Dalga formu, tepe ${track.peakDb} dBFS` : undefined} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />;
};
// inner times of a graphic move with it when it is dragged
const shiftTimes = (v, d, key = "") => {
  if (typeof v === "number") return key === "at" || key === "until" || key.endsWith("At") ? +(v + d).toFixed(2) : v;
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, d));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftTimes(x, d, k)]));
  return v;
};
const fmtEta = (s) => (s == null ? "" : s < 60 ? "bir dakikadan az kaldı" : `yaklaşık ${Math.round(s / 60)} dk kaldı`);

function ShortsPanel({ st, T, guard, reveal, sendChat }) {
  const [form, setForm] = useState({ start: 0, end: Math.min(T, 30), title: "", kicker: "", cta: "Tam video kanalda" });
  const { job, files } = st.shorts;
  const [preview, setPreview] = useState(null);
  const running = job.state === "running";
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="col" style={{ gap: 12 }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>Shorts</span>
      <div style={{ display: "grid", gridTemplateColumns: "90px 90px minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
        <label className="col t3 s12" style={{ gap: 5 }}>Başlangıç (sn)<input className="field mono" type="number" step="0.1" value={form.start} onChange={set("start")} /></label>
        <label className="col t3 s12" style={{ gap: 5 }}>Bitiş (sn)<input className="field mono" type="number" step="0.1" value={form.end} onChange={set("end")} /></label>
        <label className="col t3 s12" style={{ gap: 5 }}>Başlık<input className="field" value={form.title} onChange={set("title")} /></label>
        <label className="col t3 s12" style={{ gap: 5 }}>Kapanış yazısı<input className="field" value={form.cta} onChange={set("cta")} /></label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn" disabled={running || !st.out[0].ready} onClick={() => guard(() => post("/api/shorts", form))}>{running ? <i className="icon-loader spin" style={{ fontSize: 14 }} /> : <i className="icon-smartphone" style={{ fontSize: 14 }} />}{running ? "Üretiliyor" : "Short üret"}</button>
        <span className="s12" style={{ color: job.state === "failed" ? "var(--neg)" : "var(--t3)", lineHeight: 1.45, overflowWrap: "anywhere" }}>{job.state === "failed" ? job.error : job.state === "idle" ? "1080×1920, başlık ve kelime kelime altyazıyla." : job.last}</span>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={st.chat.busy} onClick={() => sendChat("Short için en iyi 2-3 aralığı öner. Yalnız work/transcript.tr.json'daki cümleleri kullan; aralıklar 5-180 sn, cümle başında başlayıp cümle sonunda bitsin; başlık konuşmada geçen bir cümleden olsun, uydurma rakam ya da iddia yok. Sonucu work/shorts-oneri.json dosyasına [{start, end, title, reason}] olarak yaz.")}>Claude'dan Short önerisi</button>
        {(st.shorts.suggestions ?? []).map((s, k) => (
          <div key={k} className="rule-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "6px 0" }}>
            <span className="col" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>{s.start}–{s.end} sn · {s.title}</span><span className="t3 s12">{s.reason}</span></span>
            <button className="btn sm" onClick={() => setForm({ ...form, start: s.start, end: s.end, title: s.title })}>Kullan</button>
          </div>
        ))}
      </div>
      {files.map((f) => (
        <div key={f.name} className="col" style={{ gap: 8 }}>
          <div className="rule-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 0" }}>
            <span style={{ fontWeight: 500 }}>{f.name}<span className="t3" style={{ fontWeight: 400 }}>{mb(f.size)}</span></span>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="btn sm" onClick={() => setPreview(preview === f.name ? null : f.name)}><i className="icon-play" style={{ fontSize: 13 }} />{preview === f.name ? "Kapat" : "Önizle"}</button>
              {st.youtube.connected && <button className="btn sm" disabled={st.youtube.upload.state === "running"} onClick={() => guard(() => post("/api/youtube/upload", { privacy: "private", short: f.name }))}>YouTube'a özel yükle</button>}
              <button className="btn sm" onClick={() => reveal(`shorts/${f.name}`)}><i className="icon-folder-open" style={{ fontSize: 13 }} />Göster</button>
            </span>
          </div>
          {preview === f.name && <video src={`/media/short/${encodeURIComponent(f.name)}`} controls style={{ maxHeight: 420, borderRadius: 6, background: "#000", alignSelf: "flex-start" }} />}
        </div>
      ))}
    </div>
  );
}

function YoutubePanel({ st, guard, sendChat }) {
  const yt = st.youtube, up = yt.upload;
  const [meta, setMeta] = useState(null);
  const [privacy, setPrivacy] = useState("private");
  const [armed, setArmed] = useState(false);
  const [captions, setCaptions] = useState(false);
  const file = useRef(null);
  const saved = yt.meta ?? { title: "", description: "", tags: [] };
  const savedKey = JSON.stringify(saved);
  useEffect(() => { setMeta(saved); }, [savedKey]); // Claude can write this file too
  const value = meta ?? saved;
  const save = () => post("/api/youtube/meta", value);
  const start = () => guard(async () => { await save(); await post("/api/youtube/upload", { privacy, captions, confirmPublic: privacy === "public" && armed }); setArmed(false); });
  const running = up.state === "running";
  return (
    <div className="col" style={{ gap: 10, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
      <span className="eyebrow">YouTube</span>
      <label className="col t2" style={{ gap: 5 }}>Başlık<input className="field" maxLength={100} value={value.title} onChange={(e) => setMeta({ ...value, title: e.target.value })} onBlur={() => guard(save)} /></label>
      <label className="col t2" style={{ gap: 5 }}>Açıklama<textarea className="field" rows={7} style={{ height: "auto", padding: "8px 9px", lineHeight: 1.5, resize: "vertical" }} value={value.description} onChange={(e) => setMeta({ ...value, description: e.target.value })} onBlur={() => guard(save)} /></label>
      <button className="btn sm" style={{ alignSelf: "flex-start" }} disabled={st.chat.busy} onClick={() => sendChat("YouTube başlığı ve açıklaması yaz. Yalnız work/transcript.tr.txt ve planda geçenleri kullan, konuşmada olmayan rakam ve iddia ekleme. Birden çok bölüm varsa 0:00 biçiminde bölüm listesi ekle. Sonucu work/youtube.json dosyasına {title, description, tags} olarak yaz.")}>Claude yazsın</button>
      <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => guard(async () => { const r = await post("/api/youtube/chapters"); setMeta({ ...value, description: `${value.description.trimEnd()}\n\n${r.text}`.trim() }); })}>Bölümleri ekle</button>
      {!yt.hasClient && (
        <div className="col" style={{ gap: 8 }}>
          <span className="t3 s12" style={{ lineHeight: 1.5 }}>Yüklemek için Google Cloud'da YouTube Data API v3'ü aç, "Masaüstü uygulaması" türünde OAuth istemcisi oluştur ve JSON dosyasını buraya ekle. Dosya bu bilgisayarda kalır.</span>
          <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => file.current?.click()}>İstemci dosyası ekle</button>
          <input ref={file} type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) guard(async () => post("/api/youtube/client", { text: await f.text() })); }} />
        </div>
      )}
      {yt.hasClient && !yt.connected && <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => guard(() => post("/api/youtube/connect"))}>Hesabı bağla</button>}
      {yt.connected && (
        <div className="col" style={{ gap: 8 }}>
          <label className="t3 s12" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />Türkçe altyazıyı (SRT) da yükle. Ek izin gerekir (YT_CAPTIONS=1, hesabı yeniden bağla)</label>
          <div className="seg" role="group" aria-label="Görünürlük">
            {[["private", "Özel"], ["unlisted", "Liste dışı"], ["public", "Herkese açık"]].map(([v, l]) => <button key={v} className={privacy === v ? "on" : ""} aria-pressed={privacy === v} onClick={() => { setPrivacy(v); setArmed(false); }}>{l}</button>)}
          </div>
          {privacy === "public" && !armed
            ? <button className="btn sm" disabled={running || !st.out[0].ready} onClick={() => setArmed(true)}>Herkese açık yüklemek istiyorum</button>
            : <button className="btn sm y" disabled={running || !st.out[0].ready} onClick={start}>{running ? `Yükleniyor %${up.pct}` : privacy === "public" ? "Onaylıyorum, herkese açık yükle" : "YouTube'a yükle"}</button>}
        </div>
      )}
      {up.state === "failed" && <span className="s12" style={{ color: "var(--neg)", lineHeight: 1.45 }}>{up.error}</span>}
      {up.state === "done" && <span className="s12 t2" style={{ lineHeight: 1.45, overflowWrap: "anywhere" }}>Yüklendi ({up.actualPrivacy}): {up.url}</span>}
      {up.state === "done" && up.notes?.length > 0 && <span className="s12 t3" style={{ lineHeight: 1.45 }}>{up.notes.join(" · ")}</span>}
    </div>
  );
}

const SPEECH_COLORS = { peak: "#3F7263", rms: "#7FC4AF" };
const SFX_COLORS = { peak: "#5E5478", rms: "#A898D0" };
const MUSIC_COLORS = { peak: "#7A6A2E", rms: "#D9C35A" };
const dbLabel = (track) => (track?.peakDb == null ? "" : `tepe ${dec(track.peakDb.toFixed(1))} dB`);
const LevelTag = ({ track, note }) => (track || note ? <span className="mono t3" style={{ position: "absolute", right: 6, top: 2, fontSize: 10, background: "rgba(19,18,16,.75)", padding: "0 4px", borderRadius: 3 }}>{note ?? dbLabel(track)}</span> : null);
const Marked = ({ parts }) => parts.map(([text, unc], i) => (unc ? <span key={i} className="unc">{text}</span> : <span key={i}>{text}</span>));
const Frame = ({ t, hasProxy }) => (hasProxy ? <video src={`/media/proxy#t=${t}`} muted preload="metadata" /> : null);
const Row = ({ label, children, cols = "84px minmax(0,1fr)" }) => (
  <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center" }}><span className="t2">{label}</span>{children}</div>
);

function App() {
  const [st, setSt] = useState(null);
  const [area, setArea] = useState("work");
  const [view, setView] = useState("projects");
  const [stage, setStage] = useState("plan");
  const [sel, setSel] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [events, setEvents] = useState([]);
  const [right, setRight] = useState(true);
  const [rtab, setRtab] = useState("detail");
  const [modal, setModal] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newFiles, setNewFiles] = useState([]);
  const [starting, setStarting] = useState(false);
  const [over, setOver] = useState(false);
  const [choices, setChoices] = useState(DEFAULT_CHOICES);
  const [chatInput, setChatInput] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [error, setError] = useState("");
  const [checks, setChecks] = useState({});
  const [fixes, setFixes] = useState({});
  const [tracks, setTracks] = useState(null);
  const [editing, setEditing] = useState(null);
  const lastPlan = useRef(null);
  const player = useRef(null);

  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const video = useRef(null);
  const planStamp = useRef(0);
  const slugRef = useRef(null);
  const modalRef = useRef(false);
  const chatRef = useRef(null);
  const fileInput = useRef(null);

  const refresh = useCallback(async () => {
    const s = await (await fetch("/api/state")).json();
    setSt(s);
    if (s.slug !== slugRef.current) { // another project opened: nothing of the old one may linger
      slugRef.current = s.slug;
      planStamp.current = 0; dirty.current = false;
      setSel(0); setT(0); setSaveMsg(""); setFixes({});
      try { setChecks(JSON.parse(localStorage.getItem(`checks:${s.slug}`) || "{}")); } catch { /* per-viewer convenience only */ }
    }
    // Claude can edit the plan too; take the file unless the user has unsaved typing
    if (!dirty.current && s.planMtime !== planStamp.current) { planStamp.current = s.planMtime; setEvents(s.plan.events); }
    if (!modalRef.current) setChoices(Object.fromEntries(Object.entries(DEFAULT_CHOICES).map(([k, v]) => [k, s.choices[k] ?? v])));
    return s;
  }, []);
  const busy = st?.job.state === "running" || st?.chat.busy;
  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);
  useEffect(() => {
    const id = setInterval(() => refresh().catch(() => setError("Sunucuya ulaşılamıyor.")), busy ? 1500 : 5000);
    return () => clearInterval(id);
  }, [busy, refresh]);
  const audioKey = st ? `${st.slug}:${st.audioStamp}` : null;
  useEffect(() => {
    if (!audioKey) return undefined;
    let live = true;
    setTracks(null);
    fetch("/api/tracks").then((r) => r.json()).then((x) => { if (live) setTracks(x); }).catch(() => { if (live) setTracks({}); });
    return () => { live = false; };
  }, [audioKey]);
  // the real graphics layer draws the preview: the same code and data as the render. An invalid draft keeps the last valid plan.
  const previewPlan = useMemo(() => {
    if (!st?.plan.raw) return null;
    const parsed = planSchema.safeParse({ ...st.plan.raw, events });
    if (parsed.success) lastPlan.current = parsed.data;
    return lastPlan.current;
  }, [st?.plan.raw && JSON.stringify(st.plan.raw.source), events]);
  useEffect(() => { player.current?.seekTo(Math.round(t * (previewPlan?.source.fps ?? 30))); }, [t, previewPlan]);
  const messageCount = st?.chat.messages.length;
  useEffect(() => { const el = chatRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messageCount, st?.chat.busy, rtab, right]);
  useEffect(() => { modalRef.current = modal; }, [modal]);
  // the proxy video is the clock while it plays
  useEffect(() => {
    if (!playing) return undefined;
    let raf;
    const tick = () => { if (video.current) setT(video.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  if (!st) return <div className="mono t2" style={{ padding: 28 }}>{error || "Yükleniyor…"}</div>;

  const T = st.source.duration || 0, fps = st.source.fps || 30;
  const tcode = (s) => { const f = Math.floor((s % 1) * fps); return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}:${pad(f)}`; };
  const pct = (s) => (T ? `${((Math.max(0, Math.min(T, s)) / T) * 100).toFixed(3)}%` : "0%");
  const event = events[sel] ?? events[0];
  const lanes = laneOf(events);
  const laneCount = Math.max(1, ...lanes);
  const running = st.renderState === "running", rendered = st.renderState === "done";
  const finished = st.stepsDone === 13;
  const stageDone = { desifre: st.segments.length > 0, plan: st.approved, render: rendered, teslim: finished };
  const finalReady = st.out[0].ready;

  const guard = async (fn) => { setError(""); try { await fn(); } catch (e) { setError(e.message); } await refresh().catch(() => {}); };
  const seek = (s) => { const v = Math.max(0, Math.min(T, s)); setT(v); if (video.current) video.current.currentTime = v; };
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (playing) { v.pause(); return; }
    if (v.ended || v.currentTime >= T - 0.05) v.currentTime = 0;
    v.play().catch((e) => setError(`Oynatılamadı: ${e.message}`));
  };
  const selectEv = (i) => { setSel(i); seek(events[i].start + 0.02); setRtab("detail"); setRight(true); };
  const seekClick = (e) => {
    if (e.target.closest("button")) return;
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left - 96;
    if (x >= 0) seek((x / (r.width - 96)) * T);
  };
  // edits are saved as you type; the validator rejects bad values and the draft stays on screen
  const saveEvent = (next, delay = 700, fullContent = false) => {
    dirty.current = true;
    setSaveMsg("Kaydediliyor…");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await post("/api/plan/event", { id: next.id, start: next.start, end: next.end, side: next.side, position: next.position, reason: next.reason, ...(fullContent ? { fullContent: next.content } : { content: { kicker: next.content.kicker, headline: next.content.headline, sub: next.content.sub ?? "" } }) });
        dirty.current = false;
        setSaveMsg("Kaydedildi");
        refresh().catch(() => {});
      } catch (e) { setSaveMsg(`Kaydedilmedi: ${e.message}`); }
    }, delay);
  };
  const updEv = (patch, cpatch) => {
    const current = events[sel];
    const next = { ...current, ...(patch || {}), content: { ...current.content, ...(cpatch || {}) } };
    setEvents(events.map((e, i) => (i === sel ? next : e)));
    saveEvent(next);
  };
  // timeline: drag the body to move a graphic, its edges to trim it. 0,1 s steps; the validator has the last word.
  const dragEvent = (down, i) => {
    if (down.button !== 0) return;
    const ev = events[i];
    const box = down.currentTarget.getBoundingClientRect(), track = down.currentTarget.parentElement.getBoundingClientRect();
    const mode = down.clientX - box.left < 7 ? "start" : box.right - down.clientX < 7 ? "end" : "move";
    const secondsPerPixel = T / track.width;
    let moved = false, latest = ev;
    const onMove = (m) => {
      const dx = m.clientX - down.clientX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const d = Math.round(dx * secondsPerPixel * 10) / 10;
      if (mode === "move") {
        const c = Math.min(T - ev.end, Math.max(-ev.start, d));
        latest = { ...ev, start: +(ev.start + c).toFixed(2), end: +(ev.end + c).toFixed(2), content: shiftTimes(ev.content, c) };
      } else if (mode === "start") latest = { ...ev, start: +Math.max(0, Math.min(ev.end - 0.5, ev.start + d)).toFixed(2) };
      else latest = { ...ev, end: +Math.min(T, Math.max(ev.start + 0.5, ev.end + d)).toFixed(2) };
      setEvents((cur) => cur.map((x) => (x.id === ev.id ? latest : x)));
      seek(mode === "end" ? latest.end - 0.02 : latest.start + 0.02);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) { setSel(i); saveEvent(latest, 0, true); } else selectEv(i);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const context = stage === "plan" && event ? event.id : "";
  const sendChat = (txt) => {
    const text = (txt ?? chatInput).trim();
    if (!text || st.chat.busy) return;
    setChatInput(""); setRtab("claude"); setRight(true);
    guard(() => post("/api/chat", { text, context }));
  };
  const toggleCheck = (k) => {
    const next = { ...checks, [k]: !checks[k] };
    setChecks(next);
    try { localStorage.setItem(`checks:${st.slug}`, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  };
  const uploadAll = async (files) => {
    for (const f of files) {
      const r = await fetch(`/api/assets?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      if (!r.ok) throw new Error((await r.json()).error);
    }
  };
  const startEdit = () => {
    setStarting(true);
    guard(async () => {
      if (newPath.trim()) await post("/api/project/new", { video: newPath });
      await post("/api/choices", { choices });
      await uploadAll(newFiles);
      await post("/api/chat", { text: "bunu kurgula", context: choices.profil === "D-Log M, LUT yok" ? "renk profili D-Log M, LUT uygulanmadı" : "" });
      setModal(false); setNewPath(""); setNewFiles([]);
      setArea("work"); setStage("desifre"); setRtab("claude"); setRight(true);
    }).finally(() => setStarting(false));
  };
  const onRender = () => guard(async () => { await post("/api/render"); setStage("render"); });

  let primary;
  if (stage === "plan") primary = st.approved
    ? { label: "Render'a geç", icon: "icon-arrow-right", y: true, onClick: () => setStage("render") }
    : { label: "Planı onayla", icon: "icon-check", y: true, onClick: () => guard(() => post("/api/approve", { approved: true })) };
  else if (stage === "gizlilik") primary = { label: "Render'a geç", icon: "icon-arrow-right", onClick: () => setStage("render") };
  else if (stage === "montaj") primary = { label: "Dökümle devam", icon: "icon-arrow-right", onClick: () => setStage("desifre") };
  else if (stage === "desifre") primary = { label: "Plana geç", icon: "icon-arrow-right", onClick: () => setStage("plan") };
  else if (stage === "render") primary = rendered ? { label: "Teslim'e geç", icon: "icon-arrow-right", y: true, onClick: () => setStage("teslim") }
    : running ? { label: "Render sürüyor", icon: "icon-loader spin", disabled: true }
    : { label: finalReady ? "Yeniden render et" : "Render'ı başlat", icon: "icon-play", y: true, onClick: onRender };
  else primary = { label: "Klasörü aç", icon: "icon-folder-open", onClick: () => guard(() => post("/api/reveal", { name: "" })) };

  const toastText = error || (st.missingTools.length ? `Eksik araç: ${st.missingTools.join(", ")}. Kurgu hattı bunlarsız çalışmaz.` : "");
  const toast = toastText ? (
    <div className="toast" role="alert"><span>{toastText}</span><button className="icon" style={{ width: 24, height: 24, fontSize: 14 }} aria-label="Kapat" onClick={() => setError("")}><i className="icon-x" /></button></div>
  ) : null;

  if (area === "home") {
    const pageHead = (title, sub, action) => (
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div className="col" style={{ gap: 6 }}><h1 className="h1">{title}</h1><span className="t2">{sub}</span></div>{action}
      </div>
    );
    const activeRow = st.projects.find((x) => x.active);
    return (
      <div className="app">
        <div className="home">
          <aside className="col" style={{ background: "var(--s1)", borderRight: "1px solid var(--b1)", padding: "14px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 8px 18px" }}>
              <span style={{ width: 18, height: 18, borderRadius: 4, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-ink)", fontSize: 11 }}><i className="icon-clapperboard" /></span>
              <span style={{ fontWeight: 600, fontSize: 14, letterSpacing: -0.1 }}>Kurgu Atölyesi</span>
            </div>
            <div className="col" style={{ gap: 1 }}>
              {[["projects", "Projeler", "icon-layout-grid"], ["brand", "Marka", "icon-palette"]].map(([id, label, icon]) => (
                <button key={id} className={`homenav${view === id ? " on" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><i className={icon} style={{ fontSize: 15 }} />{label}</button>
              ))}
            </div>
            <div style={{ marginTop: "auto", padding: "10px 8px", borderTop: "1px solid var(--b1)" }}><span style={{ fontWeight: 500 }}>Kurgu Atölyesi</span></div>
          </aside>
          <main style={{ minWidth: 0, overflow: "auto" }}>
            {view === "projects" && (
              <div className="col" style={{ maxWidth: 1120, margin: "0 auto", padding: "36px 40px 60px", gap: 28 }}>
                {pageHead("Projeler", "Konuşan-kafa videoları", <button className="btn y" onClick={() => setModal(true)}><i className="icon-plus" style={{ fontSize: 15 }} />Yeni video</button>)}
                {st.slug && (
                  <button className="active-card" onClick={() => setArea("work")}>
                    <div className="frame" style={{ flex: "1.25 1 420px" }}><Frame t={events[1]?.start + 2 || 1} hasProxy={st.source.hasProxy} /></div>
                    <div className="col" style={{ padding: "24px 26px", gap: 16, justifyContent: "space-between", minWidth: 0, flex: "1 1 300px" }}>
                      <div className="col" style={{ gap: 8 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--accent)", fontSize: 12, fontWeight: 500 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />{activeRow?.status}</span>
                        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2, wordBreak: "break-all" }}>{st.slug}</span>
                        {st.plan.notes[0] && <span className="t2" style={{ lineHeight: 1.5 }}>{st.plan.notes[0]}</span>}
                      </div>
                      <div className="col" style={{ gap: 10 }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          {STAGES.map(([id, label]) => (
                            <div key={id} className="col" style={{ flex: 1, gap: 6 }}>
                              <div style={{ height: 3, borderRadius: 2, background: stageDone[id] ? "var(--accent)" : "var(--b2)" }} />
                              <span className="s12" style={{ color: stageDone[id] ? "var(--t2)" : "var(--t4)" }}>{label}</span>
                            </div>
                          ))}
                        </div>
                        <span className="t3 s12">{[T ? `${dec(T)} sn` : null, st.source.fps ? `${st.source.fps} fps` : null, `${events.length} grafik`, st.createdAt].filter(Boolean).join(" · ")}</span>
                      </div>
                    </div>
                  </button>
                )}
                <div className="col" style={{ gap: 12 }}>
                  <span className="t2" style={{ fontWeight: 500 }}>Arşiv</span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 16 }}>
                    {st.projects.filter((x) => !x.active).map((x) => (
                      <button key={x.slug} className="col" title="Klasörü aç" onClick={() => guard(() => post("/api/reveal", { project: x.slug }))} style={{ gap: 10, padding: 0, border: "none", background: "transparent", color: "inherit", textAlign: "left" }}>
                        <div style={{ width: "100%", aspectRatio: "16/9", borderRadius: 8, background: "#161512", border: "1px solid var(--b1)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--b3)", fontSize: 22 }}><i className="icon-film" /></div>
                        <div className="col" style={{ gap: 3 }}><span style={{ fontWeight: 500, wordBreak: "break-all" }}>{x.slug}</span><span className="t3 s12">{x.status} · {x.date}</span></div>
                      </button>
                    ))}
                    {!st.projects.some((x) => !x.active) && <span className="t3">Henüz arşivlenmiş video yok.</span>}
                  </div>
                </div>
              </div>
            )}
            {view === "brand" && (
              <div className="col" style={{ maxWidth: 960, margin: "0 auto", padding: "36px 40px 60px", gap: 36 }}>
                {pageHead("Marka", "Grafiklerin görünümü. Claude her videodan önce bunu okur.", <button className="btn" onClick={() => { setArea("work"); setRight(true); setRtab("claude"); setChatInput("Markada şunu değiştir: "); }}>Claude ile değiştir</button>)}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 28, alignItems: "center" }}>
                  <div className="frame" style={{ borderRadius: 10, flex: "1.3 1 400px" }}><Frame t={events[0]?.start + 2 || 1} hasProxy={st.source.hasProxy} /></div>
                  <div className="col" style={{ gap: 10, flex: "1 1 260px", minWidth: 0 }}>
                    <span className="t3 s12">Marka fikri</span>
                    <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.2, lineHeight: 1.3 }}>{st.brand.idea}</span>
                    <span className="t2" style={{ lineHeight: 1.6, textWrap: "pretty" }}>{st.brand.ideaText}</span>
                  </div>
                </div>
                <section className="col" style={{ gap: 14 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Renkler</span>
                  <div className="swatches">
                    {st.brand.swatches.map((w) => (
                      <div key={w.note} className="col">
                        <div style={{ height: 64, background: w.hex }} />
                        <div className="col" style={{ padding: "10px 12px", gap: 2 }}><span style={{ fontWeight: 500 }}>{w.name}</span><span className="mono t3 s12">{w.hex}</span></div>
                      </div>
                    ))}
                  </div>
                  <span className="t3 s12" style={{ lineHeight: 1.5 }}>Sarı ekranda bakılacak tek şey. Kırmızı yalnızca yanlış iddialarda; kanal kırmızısı yalnızca abone düğmesinde.</span>
                </section>
                <section className="col" style={{ gap: 14 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Yazı</span>
                  <div style={{ border: "1px solid var(--b1)", borderRadius: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: 18, borderBottom: "1px solid var(--b1)" }}><span style={{ fontFamily: "'Inter'", fontWeight: 800, fontSize: 36, lineHeight: 1 }}>Konsolosluğa gideceğim</span><span className="t3 s12" style={{ whiteSpace: "nowrap" }}>Başlık · Inter 800</span></div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "16px 18px", borderBottom: "1px solid var(--b1)" }}><span style={{ fontFamily: "'Inter'", fontWeight: 600, fontSize: 19 }}>Göreceğiz hep beraber</span><span className="t3 s12" style={{ whiteSpace: "nowrap" }}>Metin · Inter 500–800</span></div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "16px 18px" }}><span className="mono" style={{ fontWeight: 500, fontSize: 14, letterSpacing: 1.4 }}>● 03  KİRA</span><span className="t3 s12" style={{ whiteSpace: "nowrap" }}>Etiket · JetBrains Mono</span></div>
                  </div>
                </section>
                <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 28 }}>
                  <div className="col" style={{ gap: 14 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Hareket</span>
                    <div className="col">{st.brand.motion.map((r) => <div key={r.k} className="rule-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0" }}><span className="t2">{r.k}</span><span style={{ textAlign: "right" }}>{r.v}</span></div>)}</div>
                  </div>
                  <div className="col" style={{ gap: 14 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Asla</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{st.brand.never.split(",").map((x) => x.trim()).filter(Boolean).map((x) => <span key={x} className="t2 s12" style={{ padding: "4px 9px", borderRadius: 5, background: "var(--s2)" }}>{x.charAt(0).toLocaleUpperCase("tr") + x.slice(1)}</span>)}</div>
                    <span className="t3 s12" style={{ lineHeight: 1.5 }}>Konuşmada geçmeyen rakam ve iddia yok. Yapay görsel gerçek belge gibi gösterilmez.</span>
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
        {modal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(5,5,4,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, zIndex: 10 }}>
            <div role="dialog" aria-modal="true" aria-label="Yeni video" className="col" style={{ width: 620, maxWidth: "100%", maxHeight: "100%", overflowY: "auto", overflowX: "hidden", background: "#161512", border: "1px solid var(--b2)", borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,.5)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--b1)" }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>Yeni video</span>
                <button className="icon" style={{ width: 28, height: 28 }} aria-label="Kapat" onClick={() => setModal(false)}><i className="icon-x" /></button>
              </div>
              <div className="col" style={{ padding: 20, gap: 22 }}>
                <div className="col" style={{ gap: 10 }}>
                  <label className="col" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 500 }}>Kaynak</span>
                    <input className="field" style={{ height: 34 }} placeholder={"Video dosyasının yolu, ör. C:\\Videolar\\klip.MP4"} value={newPath} onChange={(e) => setNewPath(e.target.value)} />
                  </label>
                  {newPath.trim()
                    ? <span className="t3 s12" style={{ lineHeight: 1.5 }}>Bitmiş proje {st.slug ? `(${st.slug}) ` : ""}arşivlenir, bu video kopyalanıp yeni proje açılır. Silinen dosya olmaz.</span>
                    : st.slug && (
                      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 10, border: "1px solid var(--b2)", borderRadius: 8, background: "var(--s1)" }}>
                        <div className="frame" style={{ width: 88, borderRadius: 5, flex: "none" }}><Frame t={1} hasProxy={st.source.hasProxy} /></div>
                        <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}><span style={{ fontWeight: 500 }}>Şu anki video: main.mov</span><span className="t3 s12">{dec(T)} sn · {st.source.frames} kare · {st.source.fps} fps</span></div>
                        {st.source.probed && <span className="t2 s12" style={{ display: "flex", alignItems: "center", gap: 5 }}><i className="icon-check" style={{ color: "var(--accent)" }} />Okundu</span>}
                      </div>
                    )}
                  <button className={`drop${over ? " over" : ""}`} onClick={() => fileInput.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); setNewFiles([...newFiles, ...e.dataTransfer.files]); }}>
                    <i className="icon-upload" style={{ fontSize: 15 }} />{newFiles.length ? `${newFiles.length} dosya eklendi: ${newFiles.map((f) => f.name).join(", ")}` : "Ekran kaydı, görsel veya müzik ekle"}
                  </button>
                  <input ref={fileInput} type="file" multiple hidden onChange={(e) => { setNewFiles([...newFiles, ...e.target.files]); e.target.value = ""; }} />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <span style={{ fontWeight: 500, marginBottom: 6 }}>Bu video için</span>
                  {CHOICES.map(([k, label, opts]) => (
                    <div key={k} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: 12, alignItems: "center", padding: "5px 0" }}>
                      <span className="t2">{label}</span>
                      <div className="seg" role="group" aria-label={label}>
                        {opts.map(([text, value]) => <button key={value} className={choices[k] === value ? "on" : ""} aria-pressed={choices[k] === value} onClick={() => setChoices({ ...choices, [k]: value })}>{text}</button>)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--b1)" }}>
                <button className="btn" onClick={() => setModal(false)}>Vazgeç</button>
                <button className="btn y" disabled={starting || st.chat.busy} onClick={startEdit}>{starting ? "Açılıyor…" : "Kurguya başla"}</button>
              </div>
            </div>
          </div>
        )}
        {toast}
      </div>
    );
  }

  const uncertainCount = st.uncertain.length;
  const dokumSub = st.segments.length ? `${st.segments.length} parça${uncertainCount ? ` · ${uncertainCount} belirsiz` : ""}` : "Henüz yok";
  const marked = markSegments(st.segments, st.uncertain);
  const evFor = (s) => events.find((e) => e.start >= s.start && e.start < s.end);
  const editable = event?.type === "callout";
  const firstTodo = st.steps.findIndex((s) => s.state === "todo");
  const emptyPlan = <div className="page"><div className="col" style={{ maxWidth: 720, margin: "0 auto", padding: "40px", gap: 6 }}><h1 className="h1">Plan henüz yok</h1><span className="t2">Claude'a “bunu kurgula” yaz; plan hazır olunca burada görünür.</span></div></div>;

  return (
    <div className="app">
      <div style={{ height: "100%", display: "grid", gridTemplateColumns: `minmax(0,1fr) ${right ? "clamp(280px,24vw,320px)" : "0px"}`, gridTemplateRows: "48px minmax(0,1fr)" }}>
        <header style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)", alignItems: "center", padding: "0 10px", background: "var(--s1)", borderBottom: "1px solid var(--b1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <button className="icon" title="Projeler" aria-label="Projeler" onClick={() => { setArea("home"); setView("projects"); }}><i className="icon-chevron-left" /></button>
            <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.slug ?? "Proje yok"}</span>
            {T > 0 && <span className="t3" style={{ whiteSpace: "nowrap" }}>{dec(T)} sn · {fps} fps</span>}
          </div>
          <div style={{ display: "flex", background: "var(--well)", border: "1px solid var(--b1)", borderRadius: 8, padding: 2, gap: 2 }}>
            {STAGES.map(([id, label]) => {
              const on = stage === id, done = stageDone[id];
              return (
                <button key={id} aria-current={on ? "step" : undefined} onClick={() => setStage(id)} style={{ height: 28, padding: "0 12px", border: "none", borderRadius: 6, background: on ? "var(--sel)" : "transparent", color: on ? "var(--text)" : "var(--t2)", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap" }}>
                  <span style={{ width: 16, height: 16, borderRadius: "50%", border: `1.5px solid ${done ? "var(--accent)" : "var(--t4)"}`, background: done ? "var(--accent)" : "transparent", color: "var(--accent-ink)", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>{done && <i className="icon-check" />}</span>{label}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <button className={`btn${primary.y ? " y" : ""}`} style={{ height: 30, fontWeight: 600, color: primary.disabled ? "var(--t2)" : undefined }} disabled={primary.disabled} onClick={primary.onClick}><i className={primary.icon} style={{ fontSize: 14 }} />{primary.label}</button>
            <button className="icon" title="Sağ panel" aria-label="Sağ panel" aria-pressed={right} onClick={() => setRight(!right)}><i className="icon-panel-right" /></button>
          </div>
        </header>

        <div style={{ minWidth: 0, minHeight: 0, position: "relative" }}>
          {stage === "plan" && (!event ? emptyPlan : (
            <div style={{ height: "100%", display: "grid", gridTemplateColumns: "clamp(220px,20vw,272px) minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr) 230px" }}>
              <div className="col" style={{ background: "var(--s1)", borderRight: "1px solid var(--b1)", minHeight: 0 }}>
                <div style={{ height: 38, flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", borderBottom: "1px solid var(--b1)" }}>
                  <span style={{ fontWeight: 500 }}>Döküm</span><span className="t3 s12">{dokumSub}</span>
                </div>
                <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: 6 }}>
                  {marked.map((s) => (
                    <button key={s.start} className={`dokum-row${t >= s.start && t < s.end ? " on" : ""}`} onClick={() => seek(s.start + 0.02)}>
                      <span className="mono t3" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, width: "100%" }}><span>{short(s.start)} – {short(s.end)}</span><span style={{ color: "var(--accent)" }}>{evFor(s)?.id ?? ""}</span></span>
                      <span style={{ fontSize: 13, lineHeight: 1.55 }}><Marked parts={s.parts} /></span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="col" style={{ minWidth: 0, minHeight: 0, background: "var(--bg)" }}>
                <div style={{ flex: 1, minHeight: 0, margin: "20px 24px 12px", display: "flex", alignItems: "center", justifyContent: "center", containerType: "size" }}>
                  <div style={{ position: "relative", width: "min(100cqw, calc(100cqh * 16 / 9))", aspectRatio: "16/9", background: "#000", borderRadius: 4, overflow: "hidden" }}>
                    {st.source.hasProxy && <video ref={video} src="/media/proxy" preload="auto" onClick={togglePlay} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); if (video.current) setT(video.current.currentTime); }} onEnded={() => setPlaying(false)} onLoadedMetadata={(e) => { e.target.currentTime = t; }} />}
                    {previewPlan && (
                      <Player ref={player} component={GraphicsLayer} inputProps={{ plan: previewPlan, showProxy: false }} durationInFrames={previewPlan.source.frames} fps={previewPlan.source.fps} compositionWidth={1920} compositionHeight={1080} controls={false} clickToPlay={false} doubleClickToFullscreen={false} spaceKeyToPlayOrPause={false} acknowledgeRemotionLicense style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
                    )}
                  </div>
                </div>
                <div style={{ height: 44, flex: "none", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "0 16px" }}>
                  <span className="mono" style={{ whiteSpace: "nowrap" }}>{tcode(t)} <span className="t3">/ {tcode(T)}</span></span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button className="icon" aria-label="Önceki grafik" onClick={() => { const i = events.map((e) => e.start < t - 0.1).lastIndexOf(true); selectEv(i < 0 ? 0 : i); }}><i className="icon-skip-back" /></button>
                    <button aria-label={playing ? "Duraklat" : "Oynat"} onClick={togglePlay} style={{ width: 34, height: 34, border: "none", borderRadius: "50%", background: "var(--text)", color: "var(--bg)", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}><i className={playing ? "icon-pause" : "icon-play"} /></button>
                    <button className="icon" aria-label="Sonraki grafik" onClick={() => { const i = events.findIndex((e) => e.start > t + 0.05); selectEv(i < 0 ? events.length - 1 : i); }}><i className="icon-skip-forward" /></button>
                  </div>
                  <span className="t3 s12" style={{ justifySelf: "end", whiteSpace: "nowrap" }}>Proxy · SDR önizleme</span>
                </div>
              </div>
              <div className="col" style={{ gridColumn: "1 / -1", background: "var(--s1)", borderTop: "1px solid var(--b1)", minHeight: 0 }}>
                <div onClick={seekClick} className="col" style={{ position: "relative", flex: 1, userSelect: "none", minHeight: 0, overflow: "hidden" }}>
                  <div className="tl-row" style={{ height: 26, borderBottom: "1px solid var(--b1)" }}>
                    <span style={{ borderRight: "1px solid var(--b1)" }} />
                    <div style={{ position: "relative" }}>
                      {niceTicks(T).map((k) => <span key={k.at}><span style={{ position: "absolute", left: pct(k.at), bottom: 0, height: k.major ? 8 : 4, borderLeft: "1px solid var(--b3)" }} />{k.major && <span className="mono t3" style={{ position: "absolute", left: pct(k.at), top: 5, paddingLeft: 4, fontSize: 10 }}>{short(k.at)}</span>}</span>)}
                    </div>
                  </div>
                  <div className="tl-row" style={{ height: 40 }}>
                    <div className="tl-label"><i className="icon-type" />Grafik</div>
                    <div style={{ position: "relative", overflow: "hidden" }}>
                      {events.map((e, i) => {
                        const on = i === sel;
                        return (
                          <button key={e.id} title={`${e.id} · ${eventTitle(e)}`} onPointerDown={(e) => dragEvent(e, i)} onClick={(e) => { if (e.detail === 0) selectEv(i); }} style={{ cursor: "grab", touchAction: "none", position: "absolute", top: 4 + (lanes[i] - 1) * (32 / laneCount), height: 32 / laneCount - (laneCount > 1 ? 1 : 0), left: pct(e.start), width: pct(e.end - e.start), background: on ? "var(--accent)" : "#2B2718", border: `1px solid ${on ? "var(--accent)" : "#4A421F"}`, borderRadius: 5, color: on ? "var(--accent-ink)" : "#E8DFA8", textAlign: "left", padding: "0 8px", overflow: "hidden", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500 }}>
                            <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>{e.id}</span><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{eventTitle(e)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="tl-row" style={{ height: 52 }}>
                    <div className="tl-label"><i className="icon-film" />Video</div>
                    <div style={{ position: "relative", overflow: "hidden" }}>
                      {st.source.hasProxy && <div style={{ position: "absolute", inset: "4px 0", borderRadius: 5, overflow: "hidden", border: "1px solid var(--b3)" }}><img src={`/media/film?s=${encodeURIComponent(st.slug ?? "")}`} alt="" style={{ width: "100%", height: "100%", objectFit: "fill", opacity: 0.8, display: "block" }} /></div>}
                    </div>
                  </div>
                  <div className="tl-row" style={{ height: 44 }}>
                    <div className="tl-label"><i className="icon-mic" />Konuşma</div>
                    <div style={{ position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: "4px 0", background: "#14201D", borderRadius: 5, overflow: "hidden" }}><Waveform track={tracks?.speech} colors={SPEECH_COLORS} /></div>
                      <LevelTag track={tracks?.speech} note={tracks ? (tracks.speech ? null : "ses yok") : "ölçülüyor…"} />
                    </div>
                  </div>
                  <div className="tl-row" style={{ height: 28 }}>
                    <div className="tl-label"><i className="icon-audio-lines" />Efekt</div>
                    <div style={{ position: "relative", overflow: "hidden" }}>
                      {tracks?.sfx
                        ? <><div style={{ position: "absolute", inset: "3px 0", opacity: tracks.sfxStale ? 0.45 : 1 }}><Waveform track={tracks.sfx} colors={SFX_COLORS} /></div><LevelTag track={tracks.sfx} note={tracks.sfxStale ? "plan değişti · önceki render" : null} /></>
                        : <>{events.filter((e) => e.sfx !== false).map((e) => <span key={e.id} title="Planlanan efekt" style={{ position: "absolute", left: pct(e.start), top: 9, bottom: 9, width: 2, background: "#6B6085" }} />)}<LevelTag note={st.choices.sfx === "Hiç" ? "efekt yok" : "plan · ses render'da oluşur"} /></>}
                    </div>
                  </div>
                  <div className="tl-row" style={{ height: 28 }}>
                    <div className="tl-label"><i className="icon-music" />Müzik</div>
                    <div style={{ position: "relative", overflow: "hidden" }}>
                      {tracks?.music
                        ? <><div style={{ position: "absolute", inset: "3px 0" }}><Waveform track={tracks.music} colors={MUSIC_COLORS} /></div><LevelTag track={tracks.music} /></>
                        : <span className="t4 s12" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }}>{st.audio.music === "none" ? "Müzik yok" : "public/assets içinde ses dosyası yok"}</span>}
                    </div>
                  </div>
                  <div style={{ position: "absolute", top: 0, bottom: 0, left: `calc(96px + (100% - 96px) * ${T ? (t / T).toFixed(4) : 0})`, width: 1, background: "var(--accent)", pointerEvents: "none" }}>
                    <span style={{ position: "absolute", top: 0, left: -5, width: 11, height: 12, background: "var(--accent)", clipPath: "polygon(0 0,100% 0,100% 60%,50% 100%,0 60%)" }} />
                  </div>
                </div>
              </div>
            </div>
          ))}

          {stage === "gizlilik" && <PrivacyStage setError={setError} />}
          {stage === "montaj" && <MontageStage setError={setError} onDone={() => setStage("desifre")} />}

          {stage === "desifre" && (
            <div className="page">
              <div className="col" style={{ maxWidth: 720, margin: "0 auto", padding: "40px 40px 80px", gap: 6 }}>
                <div className="col" style={{ gap: 6, marginBottom: 24 }}>
                  <h1 className="h1">Döküm</h1>
                  <span className="t2">{st.segments.length ? `whisper.cpp · Türkçe · ${st.segments.length} parça.${uncertainCount ? " Dalgalı çizgili yerler belirsiz." : ""}` : "Henüz döküm yok. Claude kurguya başlayınca burada görünür."}</span>
                </div>
                {marked.map((s) => (
                  <div key={s.start} onClick={() => { if (editing?.start !== s.start) seek(s.start + 0.02); }} style={{ display: "grid", gridTemplateColumns: "72px minmax(0,1fr) 30px", gap: 20, padding: "12px 14px", margin: "0 -14px", borderRadius: 8, cursor: "pointer", background: t >= s.start && t < s.end ? "var(--s3)" : "transparent" }}>
                    <span className="mono t3 s12" style={{ paddingTop: 4 }}>{short(s.start)}</span>
                    {editing?.start === s.start ? (
                      <textarea className="field" aria-label="Parça metni" autoFocus rows={3} style={{ height: "auto", padding: "8px 9px", fontSize: 17, lineHeight: 1.5, resize: "vertical" }} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const { start, text } = editing; guard(async () => { await post("/api/transcript/segment", { start, text }); setEditing(null); }); }
                      }} />
                    ) : <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, textWrap: "pretty" }}><Marked parts={s.parts} /></p>}
                    <button className="icon" title={editing?.start === s.start ? "Vazgeç (Esc)" : "Düzenle"} aria-label={`${short(s.start)} parçasını düzenle`} onClick={(e) => { e.stopPropagation(); setEditing(editing?.start === s.start ? null : { start: s.start, text: s.text }); }}><i className={editing?.start === s.start ? "icon-x" : "icon-pencil"} style={{ fontSize: 14 }} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stage === "render" && (
            <div className="page">
              <div className="col" style={{ maxWidth: 720, margin: "0 auto", padding: "40px 40px 80px", gap: 28 }}>
                <div className="col" style={{ gap: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
                    <div className="col" style={{ gap: 6, minWidth: 0 }}>
                      <h1 className="h1">{rendered ? "Render tamamlandı" : running ? "Render sürüyor" : st.job.state === "failed" ? "Render başarısız" : st.job.state === "stopped" ? "Render durduruldu" : "Render"}</h1>
                      <span className="t2" style={{ lineHeight: 1.5 }}>{rendered ? "Teslim dosyaları hazır." : running ? `${JOB_STEP[st.job.step] ?? "Hazırlık"}${st.job.etaSeconds != null ? `, ${fmtEta(st.job.etaSeconds)}` : ""}. Arka planda çalışıyor; bu ekranı kapatabilirsin.` : st.job.error ?? (st.approved ? `Plan onaylandı. 13 adımın ${st.stepsDone}'i tamam.${st.estimate ? ` Tahmini süre ${st.estimate.seconds < 90 ? "birkaç dakika" : `~${Math.round(st.estimate.seconds / 60)} dk`}${st.estimate.measured ? "" : " (ilk ölçüm bekleniyor)"} · disk ${st.estimate.diskFreeGB} GB boş (gereken ~${st.estimate.diskNeededGB}) · RAM ${st.estimate.ramFreeGB} GB boş${st.estimate.ramFreeGB < 4 ? ", 4K birleştirme için az: diğer uygulamaları kapat" : ""}.` : ""}` : "Render için önce planı onayla.")}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none" }}>
                      {st.job.state === "failed" && ["qc", "audio", "qcmix"].includes(st.job.step) && <button className="btn sm y" onClick={() => guard(() => post("/api/resume"))}><i className="icon-play" style={{ fontSize: 12 }} />Kalan adımları çalıştır</button>}
                      {running && <button className="btn sm" onClick={() => guard(() => post("/api/render/stop"))}><i className="icon-square" style={{ fontSize: 12 }} />Durdur</button>}
                      {rendered && !finished && <button className="btn sm" disabled={st.chat.busy} onClick={() => sendChat("Devam: görsel denetimi yap ve teslim notunu yaz.")}>Claude denetlesin</button>}
                      <span className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{rendered ? 100 : st.job.pct}%</span>
                    </div>
                  </div>
                  <div style={{ height: 4, background: "var(--b1)", borderRadius: 2, overflow: "hidden" }}><div style={{ height: "100%", background: "var(--accent)", transformOrigin: "left", transform: `scaleX(${(rendered ? 100 : st.job.pct) / 100})`, transition: "transform .15s" }} /></div>
                </div>
                <div className="col">
                  {st.steps.map((s, i) => {
                    const now = i === firstTodo && running, on = s.state === "done", skip = s.state === "skip";
                    const stateText = on ? "Tamam" : skip ? "Atlandı" : now ? "Çalışıyor" : "Sırada";
                    return (
                      <div key={s.label} className="rule-row" style={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "11px 0" }}>
                        <span style={{ width: 18, height: 18, borderRadius: "50%", border: `1.5px solid ${on ? "var(--b3)" : now ? "var(--accent)" : "var(--b2)"}`, background: on ? "#26241F" : "transparent", color: on ? "var(--text)" : "var(--t4)", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>{on ? <i className="icon-check" /> : skip ? <i className="icon-minus" /> : null}</span>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
                          <span style={{ color: on || now ? "var(--text)" : "var(--t3)", fontWeight: 500, whiteSpace: "nowrap" }}>{s.label}</span>
                          <span className="mono t4" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.cmd}</span>
                        </div>
                        <span className="s12" style={{ whiteSpace: "nowrap", color: now ? "var(--accent)" : on ? "var(--t3)" : "var(--t4)" }}>{stateText}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="col" style={{ gap: 8 }}>
                  <span className="t2" style={{ fontWeight: 500 }}>Günlük</span>
                  <div className="col mono t2 s12" style={{ background: "var(--well)", border: "1px solid var(--rule)", borderRadius: 8, padding: "12px 14px", lineHeight: 1.75, minHeight: 96, overflowWrap: "anywhere" }}>
                    {st.job.logs.map((l, i) => <span key={i}>{l}</span>)}
                    {!st.job.logs.length && <span>{rendered ? "Bu video panel dışında render edildi." : "Henüz render çalıştırılmadı."}</span>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {stage === "teslim" && (
            <div className="page">
              <div className="col" style={{ maxWidth: 880, margin: "0 auto", padding: "40px 40px 80px", gap: 28 }}>
                <div className="col" style={{ gap: 6 }}>
                  <h1 className="h1">{finalReady ? "Teslim" : "Teslim henüz hazır değil"}</h1>
                  <span className="t2">{finalReady ? "Yüklenecek video, altyazı ve ses kanalları out/ klasöründe." : "Render bitince dosyalar burada görünür."}</span>
                </div>
                <div className="frame" style={{ borderRadius: 8 }}>
                  {st.finalStill ? <img className="fill" src={`/media/final/${encodeURIComponent(st.finalStill)}`} alt="Teslim videosundan kare" style={{ opacity: finalReady ? 1 : 0.35 }} /> : <Frame t={1} hasProxy={st.source.hasProxy} />}
                  {finalReady && (
                    <div style={{ position: "absolute", left: 16, bottom: 16, display: "flex", alignItems: "center", gap: 10, background: "rgba(11,10,9,.82)", padding: "6px 12px", borderRadius: 999 }}>
                      <span style={{ fontWeight: 500 }}>final-hlg.mov</span><span className="t2">{short(T)}</span>
                    </div>
                  )}
                </div>
                <div className="col">
                  {st.out.map((o) => (
                    <div key={o.name} className="rule-row" style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "12px 0" }}>
                      <span className="t2" style={{ width: 32, height: 32, borderRadius: 7, background: "#161512", border: "1px solid var(--b1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}><i className={OUT_ICONS[o.name]} /></span>
                      <div className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 500, color: o.ready ? "var(--text)" : "var(--t3)" }}>{o.name}{o.size != null ? <span className="t3" style={{ fontWeight: 400 }}>{mb(o.size)}</span> : null}</span>
                        <span className="t3 s12">{o.desc}</span>
                      </div>
                      {o.ready ? <button className="btn sm" onClick={() => guard(() => post("/api/reveal", { name: o.name }))}><i className="icon-folder-open" style={{ fontSize: 13 }} />Göster</button> : <span className="t4 s12">Bekliyor</span>}
                    </div>
                  ))}
                </div>
                <ShortsPanel sendChat={sendChat} st={st} T={T} guard={guard} reveal={(name) => guard(() => post("/api/reveal", { name }))} />
              </div>
            </div>
          )}
        </div>

        {right && (
          <aside className="col" style={{ background: "var(--s1)", borderLeft: "1px solid var(--b1)", minHeight: 0, minWidth: 0 }}>
            <div style={{ height: 38, flex: "none", display: "flex", alignItems: "stretch", gap: 16, padding: "0 14px", borderBottom: "1px solid var(--b1)" }} role="tablist">
              {[["detail", "Detay"], ["claude", "Claude"]].map(([id, label]) => (
                <button key={id} role="tab" aria-selected={rtab === id} onClick={() => setRtab(id)} style={{ border: "none", background: "transparent", color: rtab === id ? "var(--text)" : "var(--t3)", borderBottom: `1.5px solid ${rtab === id ? "var(--text)" : "transparent"}`, marginBottom: -1, fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6, padding: 0 }}>{label}{id === "claude" && st.chat.busy && <i className="icon-loader spin" style={{ fontSize: 12, color: "var(--accent)" }} />}</button>
              ))}
            </div>

            {rtab === "detail" && (
              <div style={{ flex: 1, overflow: "auto" }}>
                {stage === "plan" && (event ? (
                  <div className="col">
                    <div className="col rule-row" style={{ padding: "16px 16px 14px", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 15, fontWeight: 600 }}>{event.id} <span className="t3" style={{ fontWeight: 400 }}>{EVENT_NAMES[event.type] ?? event.type}</span></span>
                        <div style={{ display: "flex", gap: 2 }}>
                          <button className="icon" style={{ width: 26, height: 26, fontSize: 14 }} aria-label="Önceki grafik" onClick={() => selectEv((sel + events.length - 1) % events.length)}><i className="icon-chevron-up" /></button>
                          <button className="icon" style={{ width: 26, height: 26, fontSize: 14 }} aria-label="Sonraki grafik" onClick={() => selectEv((sel + 1) % events.length)}><i className="icon-chevron-down" /></button>
                        </div>
                      </div>
                      {event.transcript && <span className="t2" style={{ lineHeight: 1.5 }}>“{event.transcript}”</span>}
                    </div>
                    {editable ? (
                      <>
                        <div className="col rule-row" style={{ padding: "14px 16px", gap: 10 }}>
                          <span className="eyebrow">İçerik</span>
                          {[["Üst etiket", "kicker", (v) => v.toLocaleUpperCase("tr")], ["Başlık", "headline", (v) => v], ["Alt satır", "sub", (v) => v]].map(([label, key, map]) => (
                            <label key={key} style={{ display: "grid", gridTemplateColumns: "84px minmax(0,1fr)", gap: 10, alignItems: "center" }}>
                              <span className="t2">{label}</span>
                              <input className="field" value={event.content[key] ?? ""} onChange={(e) => updEv(null, { [key]: map(e.target.value) })} />
                            </label>
                          ))}
                        </div>
                        <div className="col rule-row" style={{ padding: "14px 16px", gap: 10 }}>
                          <span className="eyebrow">Zamanlama ve konum</span>
                          <Row label="Süre" cols="84px minmax(0,1fr) minmax(0,1fr)">
                            {[["Giriş", "start", (v) => Math.max(0, v)], ["Çıkış", "end", (v) => Math.min(T, v)]].map(([label, key, clamp]) => (
                              <label key={key} style={{ display: "flex", alignItems: "center", height: 30, background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 6, padding: "0 8px", gap: 4 }}>
                                <span className="t3" style={{ fontSize: 11 }}>{label}</span>
                                <input type="number" step="0.1" value={event[key]} onChange={(e) => updEv({ [key]: clamp(Number(e.target.value) || 0) })} className="mono" style={{ width: "100%", minWidth: 0, background: "transparent", border: "none", color: "var(--text)", fontSize: 12, outline: "none", textAlign: "right" }} />
                              </label>
                            ))}
                          </Row>
                          <Row label="Taraf">
                            <div className="seg" role="group" aria-label="Taraf">
                              {[["left", "Sol"], ["right", "Sağ"]].map(([v, l]) => <button key={v} style={{ height: 24 }} className={event.side === v ? "on" : ""} aria-pressed={event.side === v} onClick={() => updEv({ side: v, position: v === "left" ? "sol üst panel" : "sağ üst panel" })}>{l}</button>)}
                            </div>
                          </Row>
                          {(event.enter || event.exit) && <Row label="Geçiş"><span>{[event.enter, event.exit].filter(Boolean).join(", ")}</span></Row>}
                        </div>
                        <div className="col" style={{ padding: "14px 16px", gap: 8 }}>
                          <span className="eyebrow">Neden burada</span>
                          <textarea className="field" aria-label="Neden burada" rows={3} style={{ height: "auto", padding: "8px 9px", lineHeight: 1.5, resize: "vertical" }} value={event.reason ?? ""} onChange={(e) => updEv({ reason: e.target.value })} />
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, minHeight: 28 }}>
                            <span role="status" className="s12" style={{ color: saveMsg.startsWith("Kaydedilmedi") ? "var(--neg)" : "var(--t3)", lineHeight: 1.45 }}>{saveMsg}</span>
                            {st.canUndo && <button className="btn sm" style={{ flex: "none" }} onClick={() => guard(async () => { clearTimeout(saveTimer.current); dirty.current = false; await post("/api/plan/undo"); setSaveMsg("Geri alındı"); })}><i className="icon-undo-2" style={{ fontSize: 13 }} />Geri al</button>}
                          </div>
                        </div>
                      </>
                    ) : <div className="t2" style={{ padding: 16, lineHeight: 1.5 }}>Bu grafik türünü Claude'a yazarak değiştir.</div>}
                  </div>
                ) : <div className="t3" style={{ padding: 16 }}>Seçili grafik yok.</div>)}

                {stage === "desifre" && (
                  <div className="col" style={{ padding: 16, gap: 18 }}>
                    <span className="eyebrow">Belirsiz pasajlar</span>
                    {st.uncertain.map((u) => (
                      <div key={u.text} className="col" style={{ gap: 8 }}>
                        <span style={{ fontWeight: 500 }}>“{u.text}”</span>
                        <span className="t3 s12" style={{ lineHeight: 1.45 }}>{short(u.at)} · {u.note}</span>
                        <button className="btn sm" style={{ alignSelf: "flex-start", height: 30 }} onClick={() => { new Audio(`/api/audio?at=${u.at}&len=5`).play().catch(() => {}); }}><i className="icon-play" style={{ fontSize: 12 }} />Dinle (5 sn)</button>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input className="field" aria-label={`“${u.text}” için doğrusu`} placeholder="Doğrusunu yaz" value={fixes[u.text] ?? ""} onChange={(e) => setFixes({ ...fixes, [u.text]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") guard(() => post("/api/correct", { text: u.text, to: fixes[u.text] })); }} />
                          <button className="btn sm" style={{ height: 30 }} onClick={() => guard(() => post("/api/correct", { text: u.text, to: fixes[u.text] }))}>Düzelt</button>
                        </div>
                      </div>
                    ))}
                    {!uncertainCount && <span className="t3">Belirsiz pasaj yok.</span>}
                    {uncertainCount > 0 && <span className="t3 s12" style={{ lineHeight: 1.5 }}>Düzeltme altyazı dosyasına hemen işlenir.</span>}
                  </div>
                )}

                {stage === "render" && (
                  <div className="col" style={{ padding: 16, gap: 4 }}>
                    <span className="eyebrow" style={{ marginBottom: 8 }}>Bu videonun seçimleri</span>
                    {CHOICES.map(([k, label, opts]) => <div key={k} className="rule-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0" }}><span className="t2">{label}</span><span>{opts.find(([, v]) => v === st.choices[k])?.[0] ?? "Seçilmedi"}</span></div>)}
                  </div>
                )}

                {stage === "teslim" && (
                  <div className="col" style={{ padding: 16, gap: 14 }}>
                    <span className="eyebrow">Yüklemeden önce</span>
                    <span className="t2" style={{ lineHeight: 1.5 }}>Claude sesi duyamaz{st.source.hdr ? " ve HDR'ı göremez" : " ve hareketi izleyemez"}. Bunları sen kontrol et:</span>
                    {[
                      st.choices.sfx === "Hiç" ? "Ses kulağa doğru geliyor" : `Ses efektleri${st.audio.sfxDb != null ? ` (${st.audio.sfxDb} dB)` : ""} kulağa doğru geliyor`,
                      st.source.hdr ? "HDR görüntü telefonda veya HDR ekranda doğru" : "Video baştan sona izlendi",
                      ...(uncertainCount ? [`Altyazıdaki ${uncertainCount} belirsiz pasaj doğru`] : []),
                    ].map((text) => {
                      const on = !!checks[text];
                      return (
                        <button key={text} role="checkbox" aria-checked={on} onClick={() => toggleCheck(text)} style={{ display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left", background: "transparent", border: "none", color: on ? "var(--t2)" : "var(--text)", padding: 0, fontSize: 13, lineHeight: 1.45 }}>
                          <span style={{ flex: "none", marginTop: 1, width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${on ? "var(--accent)" : "var(--b3)"}`, background: on ? "var(--accent)" : "transparent", color: "var(--accent-ink)", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>{on && <i className="icon-check" />}</span>{text}
                        </button>
                      );
                    })}
                    <YoutubePanel st={st} guard={guard} sendChat={sendChat} />
                  </div>
                )}
              </div>
            )}

            {rtab === "claude" && (
              <>
                <div ref={chatRef} className="col" style={{ flex: 1, overflow: "auto", padding: "16px 14px", gap: 18 }}>
                  {!st.chat.messages.length && <span className="t3" style={{ lineHeight: 1.5 }}>Bir değişiklik iste. Claude bu klasörde çalışır ve dosyaları değiştirebilir.</span>}
                  {st.chat.messages.map((m, i) => (m.who === "u" ? (
                    <div key={i} className="msg" style={{ alignSelf: "flex-end", maxWidth: "85%", background: "var(--b1)", borderRadius: 10, padding: "8px 11px", lineHeight: 1.5 }}>{m.text}</div>
                  ) : (
                    <div key={i} className="col" style={{ gap: 6, minWidth: 0 }}>
                      <span className="eyebrow">Claude · {m.time}</span>
                      <span className="msg" style={{ lineHeight: 1.55, color: "#DAD7D0", textWrap: "pretty" }}><Inline text={m.text} /></span>
                    </div>
                  )))}
                  {st.chat.busy && <span className="t3" style={{ display: "flex", gap: 7, alignItems: "baseline", lineHeight: 1.45 }}><i className="icon-loader spin" style={{ fontSize: 12, alignSelf: "center" }} />{st.chat.activity || "Düşünüyor…"}</span>}
                </div>
                <div className="col" style={{ padding: "10px 12px 12px", gap: 8 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {(stage === "plan" && event ? [`${event.id} sola gelsin`, "Daha sade olsun", "Bunu kural yap"] : ["Devam", "Müziği kıs", "Bunu kural yap"]).map((text) => <button key={text} className="chip" disabled={st.chat.busy} onClick={() => sendChat(text)}>{text}</button>)}
                  </div>
                  <div className="composer">
                    <textarea aria-label="Claude'a mesaj" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} rows={2} placeholder="Bir değişiklik iste…" style={{ resize: "none", background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 13, lineHeight: 1.5 }} />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="t4" style={{ fontSize: 11 }}>{context ? `Bağlam: ${context}` : "Bağlam: tüm video"}</span>
                      {st.chat.busy
                        ? <button aria-label="Durdur" title="Durdur" onClick={() => guard(() => post("/api/chat/stop"))} style={{ width: 26, height: 26, border: "none", borderRadius: 6, background: "var(--text)", color: "var(--bg)", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}><i className="icon-square" /></button>
                        : <button aria-label="Gönder" onClick={() => sendChat()} style={{ width: 26, height: 26, border: "none", borderRadius: 6, background: chatInput.trim() ? "var(--accent)" : "var(--b3)", color: "var(--accent-ink)", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}><i className="icon-arrow-up" /></button>}
                    </div>
                  </div>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
      {toast}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
