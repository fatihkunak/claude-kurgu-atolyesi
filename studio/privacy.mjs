// Gizlilik (yüz bulanıklığı) sunucu tarafı: scripts/85-privacy.mjs'in panel arayüzü.
// Dosyalar (work/privacy/): faces.raw.json (algılar), proposals.json (yüz izleri), approved.json (eşikler + bulanıklaştırılmayacak bölgeler),
// manual.json (elle kutular: plaka, tabela), mask.mkv (maske videosu). project.json → "privacy": true maskeyi birleştirmede uygular.
// "Bulanıklaştırma" işaretini kaldırılan iz, approved.json → skipIds ve exclude (iz kutusu birleşimi + süre) olarak yazılır;
// make-privacy-mask.py bilinmeyen anahtarları yok sayar.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const PAD = 0.15; // izin kutusu birleşimi etrafındaki pay (oran)

/** Bir izin dışlama kutusu: tüm örneklerin birleşimi + pay. Saf fonksiyon, test edilir. */
export function excludeFor(track, pad = PAD) {
  const xs = track.samples.map((s) => s[1]), ys = track.samples.map((s) => s[2]);
  const x1 = Math.min(...xs), y1 = Math.min(...ys);
  const x2 = Math.max(...track.samples.map((s) => s[1] + s[3])), y2 = Math.max(...track.samples.map((s) => s[2] + s[4]));
  const px = (x2 - x1) * pad, py = (y2 - y1) * pad;
  return { start: track.start, end: track.end, x: Math.max(0, Math.round(x1 - px)), y: Math.max(0, Math.round(y1 - py)), w: Math.round(x2 - x1 + 2 * px), h: Math.round(y2 - y1 + 2 * py) };
}

/** Elle kutu doğrulaması: sonlu sayılar, pozitif boyut, start<end. */
export function validBoxes(list) {
  if (!Array.isArray(list)) return "Kutu listesi yok.";
  for (const b of list) {
    const n = ["start", "end", "x", "y", "w", "h"].map((k) => Number(b?.[k]));
    if (n.some((v) => !Number.isFinite(v) || v < 0)) return "Kutu değerleri geçersiz.";
    if (!(n[1] > n[0]) || n[4] < 4 || n[5] < 4) return "Kutu süresi ya da boyutu geçersiz.";
    if (b.shape && !["box", "ellipse"].includes(b.shape)) return "Şekil box ya da ellipse olmalı.";
  }
  return null;
}

export function createPrivacy({ p, ROOT, readJson, send, jobRunning, SOURCE }) {
  const F = { raw: p("work/privacy/faces.raw.json"), props: p("work/privacy/proposals.json"), approved: p("work/privacy/approved.json"), manual: p("work/privacy/manual.json"), mask: p("work/privacy/mask.mkv"), job: p("work/privacy/job.json"), crops: p("work/privacy/crops") };
  const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };
  const mt = (f) => (existsSync(f) ? statSync(f).mtimeMs : null);
  const tracksOf = () => readJson(F.props, { tracks: [] }).tracks;

  const readJobState = () => {
    const j = readJson(F.job, { state: "idle" });
    if (j.state === "running") {
      try { process.kill(j.pid, 0); } catch {
        // panel yeniden başlamış olabilir (çıkış kodunu yakalayan dinleyici gitti): beklenen çıktı başlangıçtan sonra yazıldıysa bitmiştir
        const out = { detect: F.raw, review: F.props, mask: F.mask }[j.step];
        const ok = out && (mt(out) ?? 0) >= Date.parse(j.startedAt);
        return ok ? { ...j, state: "done" } : { ...j, state: "failed", error: "Süreç beklenmedik biçimde sonlandı." };
      }
    }
    return j;
  };
  const tail = (f, n = 4) => { try { return readFileSync(f, "utf8").split(/[\r\n]+/).filter(Boolean).slice(-n); } catch { return []; } };

  const state = () => {
    const approved = readJson(F.approved, { minSizePx: 40, minScore: 0.6, exclude: [] });
    const minPx = approved.minSizePx ?? 40, skip = new Set(approved.skipIds ?? []);
    const tracks = tracksOf().filter((t) => t.maxSizePx >= minPx).map((t) => ({ id: t.id, start: t.start, end: t.end, hits: t.hits, maxScore: t.maxScore, maxSizePx: t.maxSizePx, skip: skip.has(t.id) }));
    const job = readJobState();
    return {
      project: { enabled: readJson(p("work/project.json"), {}).privacy === true },
      source: (() => { const v = readJson(p("work/source-metadata.json"), {})?.summary?.video; return { width: v?.width ?? 3840, height: v?.height ?? 2160, duration: readJson(p("work/source-metadata.json"), {})?.summary?.durationSeconds ?? 0 }; })(),
      files: { raw: mt(F.raw), proposals: mt(F.props), mask: mt(F.mask) },
      approved: { minSizePx: minPx, minScore: approved.minScore ?? 0.6, skipCount: skip.size },
      manual: readJson(F.manual, []), tracks, total: tracksOf().length,
      job: { ...job, log: job.state === "running" ? tail(p("work/logs/privacy.log")) : [] },
    };
  };

  const post = {
    "/api/privacy/skip": (b) => {
      const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
      const tracks = tracksOf();
      if ([...ids].some((id) => !tracks.some((t) => t.id === id))) return [422, { error: "Bilinmeyen iz kimliği." }];
      const cfg = readJson(F.approved, { minSizePx: 40, minScore: 0.6, exclude: [] });
      cfg.skipIds = [...ids].sort();
      cfg.exclude = tracks.filter((t) => ids.has(t.id)).map((t) => ({ id: t.id, ...excludeFor(t) }));
      writeJson(F.approved, cfg);
      return [200, { ok: true, skipped: ids.size }];
    },
    "/api/privacy/threshold": (b) => {
      const minSizePx = Number(b.minSizePx), minScore = Number(b.minScore);
      if (!(minSizePx >= 10 && minSizePx <= 400) || !(minScore >= 0.3 && minScore <= 0.99)) return [422, { error: "Eşikler aralık dışı (boyut 10–400 px, güven 0,3–0,99)." }];
      const cfg = readJson(F.approved, { exclude: [] });
      writeJson(F.approved, { ...cfg, minSizePx, minScore });
      return [200, { ok: true }];
    },
    "/api/privacy/manual": (b) => {
      const err = validBoxes(b.boxes);
      if (err) return [422, { error: err }];
      writeJson(F.manual, b.boxes.map((x) => ({ start: Number(x.start), end: Number(x.end), x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h), shape: x.shape ?? "box" })));
      return [200, { ok: true }];
    },
    "/api/privacy/enable": (b) => {
      if (jobRunning()) return [409, { error: "Render çalışırken değiştirilemez." }];
      if (b.on && !existsSync(F.mask)) return [422, { error: "Önce maskeyi üret (Maske adımı)." }];
      const f = p("work/project.json");
      writeJson(f, { ...readJson(f, {}), privacy: !!b.on });
      return [200, { ok: true }];
    },
    "/api/privacy/run": (b) => {
      const step = String(b.step);
      if (!["detect", "review", "mask"].includes(step)) return [422, { error: "Adım detect, review ya da mask olmalı." }];
      if (jobRunning()) return [409, { error: "Render çalışırken gizlilik adımı başlatılamaz (CPU/RAM)." }];
      if (readJobState().state === "running") return [409, { error: "Bir gizlilik adımı zaten çalışıyor." }];
      if (step !== "detect" && !existsSync(F.raw)) return [422, { error: "Önce Tara adımı." }];
      mkdirSync(p("work/logs"), { recursive: true });
      const log = openSync(p("work/logs/privacy.log"), "w");
      const child = spawn(process.execPath, [p("scripts/85-privacy.mjs"), step], { cwd: ROOT, detached: true, stdio: ["ignore", log, log], windowsHide: true });
      child.unref();
      writeJson(F.job, { state: "running", step, pid: child.pid, startedAt: new Date().toISOString() });
      // süreç bitince durumu kapatan küçük bekçi (panel kapansa da iz kalır: bir sonraki okuma "failed/dead pid" görür)
      child.on?.("exit", (code) => writeJson(F.job, { state: code === 0 ? "done" : "failed", step, finishedAt: new Date().toISOString(), ...(code === 0 ? {} : { error: `Çıkış kodu ${code} (work/logs/privacy.log)` }) }));
      return [200, { ok: true }];
    },
  };

  /** GET: /api/privacy (durum), /api/privacy/crop?id=F001 (yüz kırpması), /api/privacy/frame?t=12.5 (elle kutu için tam kare, 960 px). */
  const get = async (url, req, res) => {
    if (url.pathname === "/api/privacy") { send(res, 200, state()); return true; }
    const jpeg = (file) => { res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=600" }); res.end(readFileSync(file)); };
    if (url.pathname === "/api/privacy/crop") {
      const t = tracksOf().find((x) => x.id === url.searchParams.get("id"));
      if (!t) { send(res, 404, { error: "yok" }); return true; }
      const file = path.join(F.crops, `${t.id}.jpg`);
      if (!existsSync(file)) {
        mkdirSync(F.crops, { recursive: true });
        const s = t.samples[Math.floor(t.samples.length / 2)];
        const m = Math.max(s[3], s[4]) * 1.6, size = Math.round(m);
        const x = Math.max(0, Math.round(s[1] + s[3] / 2 - m / 2)), y = Math.max(0, Math.round(s[2] + s[4] / 2 - m / 2));
        try { execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", s[0].toFixed(3), "-i", SOURCE, "-frames:v", "1", "-vf", `crop=${size}:${size}:${x}:${y},scale=200:200,eq=contrast=1.1:saturation=1.2`, "-q:v", "4", file], { windowsHide: true, timeout: 30000 }); }
        catch { send(res, 500, { error: "Kırpma çıkarılamadı." }); return true; }
      }
      jpeg(file);
      return true;
    }
    if (url.pathname === "/api/privacy/frame") {
      const t = Math.max(0, Number(url.searchParams.get("t")) || 0);
      const file = path.join(F.crops, `frame-${Math.round(t * 10)}.jpg`);
      if (!existsSync(file)) {
        mkdirSync(F.crops, { recursive: true });
        try { execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", SOURCE, "-frames:v", "1", "-vf", "scale=960:-2,eq=contrast=1.1:saturation=1.2", "-q:v", "4", file], { windowsHide: true, timeout: 30000 }); }
        catch { send(res, 500, { error: "Kare çıkarılamadı." }); return true; }
      }
      jpeg(file);
      return true;
    }
    return false;
  };

  return { post, get };
}
