// Çoklu klip timeline motoru — saf mantık (DOM/dosya yok). Panel (esbuild paketi) ve Node testleri aynı kodu kullanır.
// SceneFX'in mix editöründen (sound-platform/src/components/mix/timeline-editor.tsx, lib/timeline/*) uyarlanan davranışlar:
// çoklu iz, taşı/kırp/böl, mıknatıs (snap), ripple silme, çoklu seçim + grup taşı, kopyala/yapıştır/çoğalt, geri al/yinele (200).
// Bu motor ses/EQ'ya değil VİDEO birleştirmeye göre yazıldı: çıktısı scripts/08-assemble.mjs'in work/assemble.json biçimidir.
//
// Model:  { fps, tracks: [{id, kind:"video"|"audio", label, locked, hidden, muted}], clips: [Clip], nextId }
// Clip:   { id, trackId, src, label, kind:"hlg"|"sdr", start, srcIn, srcOut, gainDb, groupId?, crop?, fileId?, srcMax?, hasAudio? }
//         start = zaman çizelgesindeki başlangıç (sn); süre = srcOut - srcIn; hepsi kare ızgarasında.

export const MIN_DUR = 0.1;
/** Oynatma proxy'si bu uzunlukta (sn) parçalar hâlinde üretilir; parça k kaynağın [k·60, (k+1)·60) aralığını kapsar. */
export const PROXY_CHUNK = 60;
export const chunkIndex = (srcSec) => Math.floor(srcSec / PROXY_CHUNK + 1e-9);
export const chunkCount = (duration) => Math.max(1, Math.ceil(duration / PROXY_CHUNK - 1e-9));
export const HISTORY_LIMIT = 200;
export const SNAP_PX = 8;

const EPS = 1e-6;
export const dur = (c) => c.srcOut - c.srcIn;
export const end = (c) => c.start + dur(c);
/** Süreyi kare ızgarasına yuvarlar. */
export const q = (t, fps) => Math.round(t * fps) / fps;
const clone = (m) => ({ ...m, tracks: m.tracks.map((t) => ({ ...t })), clips: m.clips.map((c) => ({ ...c })), zooms: (m.zooms ?? []).map((z) => ({ ...z })) });

export function createModel({ fps = 30, tracks } = {}) {
  return {
    fps,
    tracks: tracks ?? [
      { id: "V1", kind: "video", label: "Video 1", locked: false, hidden: false, muted: false },
      { id: "A1", kind: "audio", label: "Ses 1", locked: false, hidden: false, muted: false },
    ],
    clips: [],
    zooms: [],
    nextId: 1,
  };
}

// ───────────── kamera hareketleri (zoom / punch-in) ─────────────
// Zoom = ÇIKIŞ zaman çizelgesinde { id, from, to, z, cx, cy, in, out }; scripts/08-assemble.mjs ile aynı anlam:
// z = ölçek (1.12 = punch-in), cx/cy = kadrajda kalan nokta (0–1), in/out = rampa sn (0 = kesme anında sert).
export const ZOOM_MIN = 1.01, ZOOM_MAX = 2.5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (u) => u * u * (3 - 2 * u);
const zoomEnv = (z, t) => {
  if (t < z.from || t > z.to) return 0;
  const up = z.in > 0 ? smooth(clamp((t - z.from) / z.in, 0, 1)) : 1;
  const down = z.out > 0 ? smooth(clamp((z.to - t) / z.out, 0, 1)) : t < z.to ? 1 : 0;
  return up * down;
};
/** t anındaki kamera: { z, cx, cy } (08-assemble'ın ffmpeg ifadesiyle aynı toplama) + kadrajın sol-üst köşesi { x0, y0 } (kare genişliği/yüksekliği cinsinden). */
export function zoomAt(zooms, t) {
  let z = 1, cx = 0.5, cy = 0.5;
  for (const m of zooms ?? []) { const e = zoomEnv(m, t); z += (m.z - 1) * e; cx += (m.cx - 0.5) * e; cy += (m.cy - 0.5) * e; }
  return { z, cx, cy, x0: clamp(cx * z - 0.5, 0, z - 1), y0: clamp(cy * z - 0.5, 0, z - 1) };
}
const cleanZoom = (m) => {
  const z = { ...m };
  for (const k of ["from", "to", "z", "cx", "cy", "in", "out"]) if (!Number.isFinite(z[k])) throw new Error(`Zoom: "${k}" sayı olmalı.`);
  z.z = clamp(z.z, ZOOM_MIN, ZOOM_MAX);
  z.cx = clamp(z.cx, 0, 1); z.cy = clamp(z.cy, 0, 1);
  if (z.from < 0) z.from = 0;
  if (z.to - z.from < MIN_DUR - 1e-6) throw new Error(`Zoom en az ${MIN_DUR} sn sürmeli.`);
  z.in = clamp(z.in, 0, (z.to - z.from) / 2); z.out = clamp(z.out, 0, (z.to - z.from) / 2);
  return z;
};
/** Zoom ekler (kareye yuvarlı). Varsayılan: 2 sn, 1.12×, ortada, 0,3 sn rampa. */
export function addZoom(model, spec = {}) {
  const m = clone(model);
  const from = q(spec.from ?? 0, m.fps);
  const z = cleanZoom({ z: 1.12, cx: 0.5, cy: 0.5, in: 0.3, out: 0.3, ...spec, from, to: q(spec.to ?? from + 2, m.fps) });
  z.id = `z${m.nextId++}`;
  m.zooms = [...m.zooms, z];
  return { model: m, created: [z.id] };
}
export function setZoomMove(model, id, patch) {
  const cur = (model.zooms ?? []).find((x) => x.id === id);
  if (!cur) throw new Error("Zoom yok.");
  const m = clone(model);
  const z = cleanZoom({ ...cur, ...patch, from: q(patch.from ?? cur.from, m.fps), to: q(patch.to ?? cur.to, m.fps) });
  m.zooms = m.zooms.map((x) => (x.id === id ? z : x));
  return m;
}
/**
 * Zoom çubuğunu dt sn sürükler. mode: "move" (gövde) | "left" | "right" (kenar). snap: { threshold, playhead } → klip kenarlarına,
 * oynatma kafasına, 0'a ve diğer zoom'ların kenarlarına yapışır (taşımada başı ya da sonu, hangisi yakınsa). Geçersizse hata atar.
 * Dönüş: { model, snapped } (snapped = yapışılan nokta ya da null).
 */
export function dragZoom(model, id, mode, dt, { snap } = {}) {
  const zm = (model.zooms ?? []).find((x) => x.id === id);
  if (!zm) throw new Error("Zoom yok.");
  const pts = snap ? [...snapPoints(model, { playhead: snap.playhead }), ...model.zooms.filter((x) => x.id !== id).flatMap((x) => [x.from, x.to])] : [];
  const stick = (t) => (snap ? snapTime(t, pts, snap.threshold) : t);
  let snapped = null;
  const hit = (raw, got) => { if (snap && Math.abs(got - raw) > 1e-9) snapped = got; return got; };
  let patch;
  if (mode === "move") {
    const len = zm.to - zm.from, a = Math.max(0, zm.from + dt);
    // başı mı sonu mu yapıştı: yapışmayan taraf "0 mesafe" sayılmasın
    const gap = (t) => { const s = stick(t); return Math.abs(s - t) > 1e-9 ? Math.abs(s - t) : Infinity; };
    const useEnd = gap(a + len) < gap(a);
    const from = Math.max(0, useEnd ? hit(a + len, stick(a + len)) - len : hit(a, stick(a)));
    patch = { from, to: from + len };
  } else if (mode === "left") patch = { from: Math.min(Math.max(0, hit(zm.from + dt, stick(zm.from + dt))), zm.to - MIN_DUR) };
  else patch = { to: Math.max(hit(zm.to + dt, stick(zm.to + dt)), zm.from + MIN_DUR) };
  return { model: setZoomMove(model, id, patch), snapped };
}
/** Üst üste binen zoom'lar ayrı şeritlere dizilir (hepsi tutulabilsin): { id → şerit no }, şerit sayısı. */
export function zoomLanes(zooms) {
  const ends = [], lane = {};
  for (const z of [...zooms].sort((a, b) => a.from - b.from || a.to - b.to)) {
    let k = ends.findIndex((e) => e <= z.from + 1e-9);
    if (k < 0) { k = ends.length; ends.push(0); }
    ends[k] = z.to; lane[z.id] = k;
  }
  return { lane, count: Math.max(1, ends.length) };
}
export function removeZoomMove(model, id) {
  const m = clone(model);
  m.zooms = m.zooms.filter((x) => x.id !== id);
  return m;
}

export const clipById = (m, id) => m.clips.find((c) => c.id === id);
export const trackById = (m, id) => m.tracks.find((t) => t.id === id);
export const clipsOn = (m, trackId) => m.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
export const totalDuration = (m) => m.clips.reduce((a, c) => Math.max(a, end(c)), 0);
const isLocked = (m, c) => !!trackById(m, c.trackId)?.locked;
const newId = (m) => `c${m.nextId++}`;

// ───────────── izler ─────────────
export function addTrack(model, kind, label) {
  const m = clone(model);
  const n = m.tracks.filter((t) => t.kind === kind).length + 1;
  const prefix = kind === "video" ? "V" : "A";
  let id = `${prefix}${n}`;
  while (m.tracks.some((t) => t.id === id)) id = `${prefix}${Number(id.slice(1)) + 1}`;
  const track = { id, kind, label: label ?? `${kind === "video" ? "Video" : "Ses"} ${n}`, locked: false, hidden: false, muted: false };
  // video izleri üstte (yüksek numara en üstte), ses izleri altta
  if (kind === "video") m.tracks.unshift(track); else m.tracks.push(track);
  return m;
}
export function setTrack(model, id, patch) {
  const m = clone(model);
  Object.assign(trackById(m, id), patch);
  return m;
}
export function removeTrack(model, id) {
  if (model.clips.some((c) => c.trackId === id)) throw new Error("İz boş değil: önce klipleri sil.");
  if (model.tracks.filter((t) => t.kind === trackById(model, id)?.kind).length < 2) throw new Error("Son iz silinemez.");
  const m = clone(model);
  m.tracks = m.tracks.filter((t) => t.id !== id);
  return m;
}

// ───────────── klipler ─────────────
/** Boş yere uygun mıknatıs: aynı izde çakışırsa klibi izin sonuna iter. */
export function addClip(model, spec, { at } = {}) {
  const m = clone(model);
  const track = trackById(m, spec.trackId ?? m.tracks.find((t) => t.kind === (spec.audioOnly ? "audio" : "video")).id);
  if (!track) throw new Error("İz yok.");
  if (track.locked) throw new Error("İz kilitli.");
  const c = {
    id: newId(m), trackId: track.id, src: spec.src, label: spec.label ?? spec.src.split(/[\\/]/).pop(), kind: spec.kind ?? "hlg",
    srcIn: q(spec.srcIn ?? 0, m.fps), srcOut: q(spec.srcOut, m.fps), gainDb: spec.gainDb ?? 0, start: 0,
    ...(spec.crop ? { crop: spec.crop } : {}),
    ...(spec.fileId ? { fileId: spec.fileId } : {}),
    ...(spec.hasAudio ? { hasAudio: true } : {}), // video klibinin kendi sesi var: timeline'da dalga formu çizilir
    ...(spec.srcMax != null ? { srcMax: spec.srcMax } : {}), // kaynak dosyanın süresi: kırpma bunu aşamaz
  };
  if (!(dur(c) >= MIN_DUR)) throw new Error("Klip çok kısa.");
  const last = clipsOn(m, track.id).at(-1);
  c.start = q(at ?? (last ? end(last) : 0), m.fps);
  m.clips.push(c);
  assertNoOverlap(m, track.id);
  return { model: m, id: c.id };
}

function assertNoOverlap(m, trackId) {
  const list = clipsOn(m, trackId);
  for (let i = 1; i < list.length; i++) {
    if (list[i].start < end(list[i - 1]) - EPS) throw new Error(`Çakışma: "${list[i - 1].label}" ve "${list[i].label}" aynı izde üst üste biniyor.`);
  }
}

/** Seçili kliplerin (grup üyeleriyle) kimlikleri. */
export function expandGroups(model, ids) {
  const set = new Set(ids);
  for (const c of model.clips) if (set.has(c.id) && c.groupId) for (const o of model.clips) if (o.groupId === c.groupId) set.add(o.id);
  return [...set];
}

/** Mıknatıs noktaları: 0, oynatma kafası, tüm klip kenarları (hariç tutulanlar dışında). */
export function snapPoints(model, { exclude = [], playhead } = {}) {
  const pts = new Set([0]);
  if (playhead != null) pts.add(playhead);
  const skip = new Set(exclude);
  for (const c of model.clips) if (!skip.has(c.id)) { pts.add(c.start); pts.add(end(c)); }
  return [...pts];
}
/** t'ye eşikten yakın en yakın nokta; yoksa t. */
export function snapTime(t, points, threshold) {
  let best = t, d = threshold;
  for (const p of points) { const x = Math.abs(p - t); if (x <= d) { d = x; best = p; } }
  return best;
}

/**
 * Klipleri dt kadar taşır (grup + çoklu seçim birlikte). Mıknatıs: ilk klibin başı ve herhangi birinin sonu noktalara yapışır.
 * Aynı izde çakışma olursa hata atar (çağıran önceki modelde kalır). toTrack: tek klip için iz değiştirme (aynı tür).
 */
export function moveClips(model, ids, dt, { snap, toTrack } = {}) {
  const m = clone(model);
  const all = expandGroups(m, ids);
  const moving = all.map((id) => clipById(m, id)).filter(Boolean);
  if (moving.some((c) => isLocked(m, c) || c.pinned)) throw new Error("Kilitli iz ya da sabit klip taşınamaz.");
  let delta = dt;
  if (snap) {
    const pts = snapPoints(m, { exclude: all, playhead: snap.playhead });
    let best = null;
    for (const c of moving) for (const edge of [c.start + dt, end(c) + dt]) {
      const s = snapTime(edge, pts, snap.threshold);
      if (s !== edge && (best === null || Math.abs(s - edge) < Math.abs(best))) best = s - edge;
    }
    if (best !== null) delta = dt + best;
  }
  const minStart = Math.min(...moving.map((c) => c.start));
  delta = Math.max(delta, -minStart); // 0'ın soluna çıkamaz
  for (const c of moving) c.start = q(c.start + delta, m.fps);
  if (toTrack && moving.length === 1) {
    const dst = trackById(m, toTrack), src = trackById(m, moving[0].trackId);
    if (!dst || dst.locked) throw new Error("Hedef iz kilitli ya da yok.");
    if (dst.kind !== src.kind) throw new Error("Video klibi ses izine taşınamaz.");
    moving[0].trackId = toTrack;
  }
  for (const t of new Set(moving.map((c) => c.trackId))) assertNoOverlap(m, t);
  return m;
}

/** Kenardan kırp: edge "left" ya da "right"; t zaman çizelgesi saniyesi. Kaynak sınırını aşamaz (srcMax verilirse). */
export function trimClip(model, id, edge, t, { snap, srcMax } = {}) {
  const m = clone(model);
  const c = clipById(m, id);
  if (!c) throw new Error("Klip yok.");
  if (isLocked(m, c) || c.pinned) throw new Error("Kilitli klip kırpılamaz.");
  let x = t;
  if (snap) x = snapTime(x, snapPoints(m, { exclude: [id], playhead: snap.playhead }), snap.threshold);
  x = q(x, m.fps);
  if (edge === "left") {
    const newStart = Math.min(Math.max(x, 0), end(c) - MIN_DUR);
    const srcIn = Math.max(0, c.srcIn + (newStart - c.start));
    if (c.srcIn + (newStart - c.start) < 0) return m; // kaynağın başından öteye açılmaz
    c.start = newStart; c.srcIn = q(srcIn, m.fps);
  } else {
    let newEnd = Math.max(x, c.start + MIN_DUR);
    let srcOut = c.srcIn + (newEnd - c.start);
    if (srcMax != null && srcOut > srcMax) { srcOut = srcMax; newEnd = c.start + (srcOut - c.srcIn); }
    c.srcOut = q(srcOut, m.fps);
  }
  assertNoOverlap(m, c.trackId);
  return m;
}

/** t anında böler. ids verilirse yalnız onlar (ve grupları), yoksa t'yi kesen tüm kilitsiz klipler. İkinci yarı yeni kimlik alır. */
export function splitAt(model, t, ids) {
  const m = clone(model);
  const tt = q(t, m.fps);
  const targets = (ids ? expandGroups(m, ids).map((id) => clipById(m, id)) : m.clips).filter((c) => c && !isLocked(m, c) && tt > c.start + EPS && tt < end(c) - EPS);
  const created = [];
  for (const c of targets) {
    if (tt - c.start < MIN_DUR - EPS || end(c) - tt < MIN_DUR - EPS) continue;
    const right = { ...c, id: newId(m), start: tt, srcIn: q(c.srcIn + (tt - c.start), m.fps) };
    c.srcOut = right.srcIn;
    m.clips.push(right);
    created.push(right.id);
  }
  if (!created.length) throw new Error("Bölünecek klip yok (oynatma kafası bir klibin içinde olmalı, uçlardan en az 0,1 sn uzakta).");
  return { model: m, created };
}

/** Siler. ripple: aynı izde sağdaki klipler boşluğu kapatır. */
export function deleteClips(model, ids, { ripple = false } = {}) {
  const m = clone(model);
  const all = new Set(expandGroups(m, ids));
  const gone = m.clips.filter((c) => all.has(c.id) && !isLocked(m, c));
  if (!gone.length) throw new Error("Silinecek klip yok (iz kilitli olabilir).");
  const goneIds = new Set(gone.map((c) => c.id));
  m.clips = m.clips.filter((c) => !goneIds.has(c.id));
  if (ripple) {
    for (const g of [...gone].sort((a, b) => b.start - a.start)) {
      for (const c of m.clips) if (c.trackId === g.trackId && c.start >= end(g) - EPS && !isLocked(m, c)) c.start = q(Math.max(0, c.start - dur(g)), m.fps);
    }
  }
  return m;
}

/** Kopya (Ctrl+D): her klibi kendi izinde hemen sonrasına koyar (çakışırsa izin sonuna). Yeni kimlikleri döndürür. */
export function duplicateClips(model, ids) {
  const m = clone(model);
  const src = expandGroups(m, ids).map((id) => clipById(m, id)).filter(Boolean);
  const gmap = new Map();
  const created = [];
  for (const c of src) {
    const copy = { ...c, id: newId(m) };
    if (c.groupId) { if (!gmap.has(c.groupId)) gmap.set(c.groupId, `g${m.nextId++}`); copy.groupId = gmap.get(c.groupId); }
    const trackEnd = Math.max(...clipsOn(m, c.trackId).map(end));
    copy.start = q(Math.max(end(c), trackEnd), m.fps);
    m.clips.push(copy);
    created.push(copy.id);
  }
  return { model: m, created };
}

/** Pano: kopyalanan klipler göreli konumlarıyla saklanır; yapıştırma t anından başlar, hedef iz kilitliyse aynı türden ilk açık izi seçer. */
export function copyToClipboard(model, ids) {
  const src = expandGroups(model, ids).map((id) => clipById(model, id)).filter(Boolean);
  if (!src.length) return null;
  const t0 = Math.min(...src.map((c) => c.start));
  return { clips: src.map((c) => ({ ...c, rel: c.start - t0 })) };
}
export function pasteClipboard(model, clip, t) {
  if (!clip) throw new Error("Pano boş.");
  const m = clone(model);
  const gmap = new Map(), created = [];
  for (const c of clip.clips) {
    let track = trackById(m, c.trackId);
    if (!track || track.locked) track = m.tracks.find((x) => x.kind === (trackById(model, c.trackId)?.kind ?? "video") && !x.locked);
    if (!track) throw new Error("Yapıştırılacak açık iz yok.");
    const { rel, ...rest } = c;
    const copy = { ...rest, id: newId(m), trackId: track.id, start: q(t + rel, m.fps) };
    if (c.groupId) { if (!gmap.has(c.groupId)) gmap.set(c.groupId, `g${m.nextId++}`); copy.groupId = gmap.get(c.groupId); }
    m.clips.push(copy);
    created.push(copy.id);
  }
  for (const tr of new Set(m.clips.map((c) => c.trackId))) assertNoOverlap(m, tr);
  return { model: m, created };
}

export function groupClips(model, ids) {
  const m = clone(model);
  const g = `g${m.nextId++}`;
  for (const id of ids) { const c = clipById(m, id); if (c) c.groupId = g; }
  return m;
}
export function ungroupClips(model, ids) {
  const m = clone(model);
  for (const c of expandGroups(m, ids).map((id) => clipById(m, id))) if (c) delete c.groupId;
  return m;
}
export function setClip(model, id, patch) {
  const m = clone(model);
  const c = clipById(m, id);
  if (!c) throw new Error("Klip yok.");
  if (isLocked(m, c)) throw new Error("İz kilitli.");
  Object.assign(c, patch);
  if (patch.start != null) c.start = q(Math.max(0, patch.start), m.fps);
  assertNoOverlap(m, c.trackId);
  return m;
}

/** Kement/kutu seçimi: zaman aralığı + iz kümesiyle kesişen klipler. */
export function clipsInRect(model, t0, t1, trackIds) {
  const [a, b] = t0 < t1 ? [t0, t1] : [t1, t0];
  const set = new Set(trackIds);
  return model.clips.filter((c) => set.has(c.trackId) && c.start < b && end(c) > a).map((c) => c.id);
}

/** Boşlukları kapat (video izi): bir iz boyunca klipleri sola yaslar. */
export function closeGaps(model, trackId) {
  const m = clone(model);
  let t = 0;
  for (const c of clipsOn(m, trackId)) { c.start = q(t, m.fps); t = end(c); }
  return m;
}

// ───────────── oynatma ─────────────
/** t anında görünen video klibi: gizli olmayan video izlerinden en üsttekinin (listede en önce gelen) klibi; yoksa null. */
export function videoClipAt(model, t) {
  for (const tr of model.tracks) {
    if (tr.kind !== "video" || tr.hidden) continue;
    const c = model.clips.find((x) => x.trackId === tr.id && t >= x.start - EPS && t < end(x) - EPS);
    if (c) return c;
  }
  return null;
}
/** t anında çalan ses klibi (sessize alınmamış ses izlerinden ilki); yoksa null. */
export function audioClipAt(model, t) {
  for (const tr of model.tracks) {
    if (tr.kind !== "audio" || tr.muted) continue;
    const c = model.clips.find((x) => x.trackId === tr.id && t >= x.start - EPS && t < end(x) - EPS);
    if (c) return c;
  }
  return null;
}
/** Klibin kaynak dosyasındaki karşılığı: t zamanındaki kaynak saniyesi. */
export const sourceTime = (c, t) => c.srcIn + (t - c.start);
const mediaUrl = (id, chunk) => `/api/montage/media?id=${id}${chunk != null ? `&chunk=${chunk}` : ""}`;
/**
 * Video klibinin t anındaki proxy parçası: { url, want } (want = parça içindeki saniye). Parça henüz üretilmediyse null.
 * files: bin kayıtları (id → { chunks: bool[] }).
 */
export function videoSource(c, t, files) {
  const f = files?.[c?.fileId];
  if (!f?.chunks) return null;
  const s = sourceTime(c, t), k = chunkIndex(s);
  return f.chunks[k] ? { url: mediaUrl(c.fileId, k), want: s - k * PROXY_CHUNK } : null;
}
/** Ses klibinin t anındaki kaynağı: özgün dosya, kaynak saniyesi. */
export const audioSource = (c, t) => (c?.fileId ? { url: mediaUrl(c.fileId), want: sourceTime(c, t) } : null);

/** Kaynak saniyesinden zaman çizelgesi saniyesi (oynatmada video saati → çizelge saati). */
export const timelineTime = (c, srcSec) => c.start + (srcSec - c.srcIn);

// ───────────── geri al / yinele ─────────────
export function createHistory(initial, limit = HISTORY_LIMIT) {
  return { past: [], present: initial, future: [], limit };
}
/** Yeni durumu işler; aynıysa (referans) hiçbir şey eklemez. */
export function commit(h, next) {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  if (past.length > h.limit) past.shift();
  return { ...h, past, present: next, future: [] };
}
export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;
export function undo(h) {
  if (!h.past.length) return h;
  return { ...h, past: h.past.slice(0, -1), present: h.past.at(-1), future: [h.present, ...h.future] };
}
export function redo(h) {
  if (!h.future.length) return h;
  return { ...h, past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

// ───────────── dışa aktar: work/assemble.json ─────────────
/**
 * Ana sıra = en alttaki video izi (V1). Bitişik olmalı (boşluk = hata; "Boşlukları kapat" ile kapanır).
 * pieces: scripts/08-assemble.mjs biçimi { src, from, to, kind, gainDb?, crop? }. Çıktı HLG'dir; tüm parçalar sdr ise "sdr".
 */
export function toAssemble(model, { trackId } = {}) {
  const vt = trackId ?? [...model.tracks].reverse().find((t) => t.kind === "video")?.id;
  const list = clipsOn(model, vt);
  if (!list.length) throw new Error("Birleştirilecek video klibi yok.");
  const fps = model.fps;
  let t = 0;
  for (const c of list) {
    if (Math.abs(c.start - t) > 0.5 / fps) throw new Error(`"${c.label}" öncesinde ${(c.start - t).toFixed(2)} sn boşluk var. "Boşlukları kapat"ı kullan.`);
    t = end(c);
  }
  const allSdr = list.every((c) => c.kind === "sdr");
  const pieces = list.map((c) => ({
    src: c.src, from: c.srcIn, to: c.srcOut, kind: c.kind,
    ...(c.gainDb ? { gainDb: c.gainDb } : {}), ...(c.crop ? { crop: c.crop } : {}),
  }));
  // zoom'lar çıkış süresinin dışına taşamaz; tamamen dışarıda kalan atılır
  const outEnd = t;
  const zooms = (model.zooms ?? []).filter((z) => z.from < outEnd - 1e-6).sort((a, b) => a.from - b.from)
    .map((z) => ({ from: z.from, to: Math.min(z.to, outEnd), z: z.z, cx: z.cx, cy: z.cy, in: z.in, out: z.out }));
  return { output: allSdr ? "sdr" : "hlg", pieces, zooms };
}

/**
 * Ses izindeki müzik klibi → work/audio/selection.json alanları (scripts/75-audio.mjs, musicPlace). Hat tek müzik stem'i kurar:
 * en fazla BİR klip. Sessize alınmış iz ya da klipsiz ses izi → null (selection.json'daki müziğe dokunulmaz).
 */
export function toSelection(model) {
  const aud = model.clips.filter((c) => { const t = trackById(model, c.trackId); return t?.kind === "audio" && !t.muted; });
  if (!aud.length) return null;
  if (aud.length > 1) throw new Error(`Ses izinde ${aud.length} klip var; hat tek müzik klibi destekler (fazlasını sil ya da izi sustur).`);
  const c = aud[0];
  return { music: c.src, musicPlace: { start: c.start, in: c.srcIn, out: c.srcOut, ...(c.gainDb ? { gainDb: c.gainDb } : {}) } };
}

/** assemble.json → model (V1'e ardışık); "Tekrar aç" için. */
export function fromAssemble(spec, fps = 30) {
  let m = createModel({ fps });
  for (const pc of spec.pieces) {
    ({ model: m } = addClip(m, { trackId: "V1", src: pc.src, srcIn: pc.from, srcOut: pc.to, kind: pc.kind, gainDb: pc.gainDb, crop: pc.crop }));
  }
  for (const z of spec.zooms ?? []) ({ model: m } = addZoom(m, { from: z.from, to: z.to, z: z.z, cx: z.cx ?? 0.5, cy: z.cy ?? 0.5, in: z.in ?? 0, out: z.out ?? 0 }));
  return m;
}

// ───────────── cetvel ─────────────
export const pxPerSec = (zoom) => 20 * Math.pow(1.35, zoom); // üstel zoom (SceneFX TimelineScale benzeri)
export const timeToX = (t, zoom) => t * pxPerSec(zoom);
export const xToTime = (x, zoom) => x / pxPerSec(zoom);
/** Cetvel çentik aralığı (sn): ekranda ≥ 60 px olacak en küçük "güzel" adım. */
export function tickStep(zoom) {
  const steps = [1 / 30, 1 / 10, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pxPerSec(zoom) >= 60) ?? steps.at(-1);
}
export const timecode = (s, fps) => {
  const f = Math.floor((s % 1) * fps + 1e-6), t = Math.floor(s + 1e-6);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(Math.floor(t / 60))}:${p2(t % 60)}:${p2(f)}`;
};
