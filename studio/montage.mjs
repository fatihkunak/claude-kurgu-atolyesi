// Montaj (çoklu klip) sunucu tarafı: klip kutusu (bin), kare önizleme, kaydet, birleştir.
// Durum dosyaları: work/montage.json (timeline modeli), work/montage-bin.json (eklenen kaynak dosyalar),
// work/assemble.json (08-assemble.mjs girdisi), work/montage-build.json (birleştirme durumu).
// Kaynak dosyalar ASLA değiştirilmez/kopyalanmaz; yalnız yolları kaydedilir. Önizleme sadece kayıtlı kimliklerle servis edilir.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROXY_CHUNK, chunkCount, chunkIndex, toAssemble, toSelection } from "./timeline/engine.mjs";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi", ".mts"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aif", ".aiff"]);

/** Örnek dizisini perSec bin/sn tepe değerine indirir; en büyük tepe 100 olacak şekilde ölçekler. */
export function wavePeaks(samples, sr, perSec) {
  const step = Math.max(1, Math.floor(sr / perSec));
  const n = Math.ceil(samples.length / step);
  const peaks = new Array(n).fill(0);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(samples.length, (i + 1) * step);
    for (let k = i * step; k < end; k++) { const v = Math.abs(samples[k]); if (v > m) m = v; }
    peaks[i] = m; if (m > max) max = m;
  }
  return { perSec: sr / step, peaks: peaks.map((v) => (max > 0 ? Math.round((v / max) * 100) : 0)) };
}

export function createMontage({ p, ROOT, readJson, send, jobRunning, serveFile }) {
  const FILES = { model: p("work/montage.json"), bin: p("work/montage-bin.json"), build: p("work/montage-build.json"), thumbs: p("work/montage-thumbs"), proxies: p("work/montage-proxy"), waves: p("work/montage-wave") };
  const readBin = () => readJson(FILES.bin, { files: [] });
  const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };

  /** ffprobe → klip kutusu kaydı. HLG (arib-std-b67) "hlg", PQ reddedilir, gerisi "sdr". */
  const probeFile = (abs) => {
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,r_frame_rate,width,height,color_transfer,duration:format=duration", "-of", "json", abs], { encoding: "utf8", windowsHide: true }));
    const v = j.streams.find((s) => s.codec_type === "video" && s.r_frame_rate !== "0/0" && !/mjpeg|png/.test(s.codec_name ?? ""));
    if (!v) {
      // yalnız ses (müzik): video akışı yok (kapak resmi MJPEG sayılmaz)
      if (!j.streams.some((s) => s.codec_type === "audio")) throw new Error("Dosyada ne video ne ses akışı var.");
      const d = Number(j.format?.duration);
      if (!(d > 0)) throw new Error("Süre okunamadı.");
      return { duration: d, fps: null, width: null, height: null, kind: "audio", hasAudio: true };
    }
    if (v.color_transfer === "smpte2084") throw new Error("PQ (HDR10) kaynaklar desteklenmiyor: yalnız HLG ya da SDR.");
    const [n, d] = v.r_frame_rate.split("/").map(Number);
    const duration = Number(j.format?.duration ?? v.duration);
    if (!(duration > 0) || !n || !d) throw new Error("Süre ya da kare hızı okunamadı.");
    return { duration, fps: n / d, width: v.width, height: v.height, kind: v.color_transfer === "arib-std-b67" ? "hlg" : "sdr", hasAudio: j.streams.some((s) => s.codec_type === "audio") };
  };

  const readBuild = () => {
    const b = readJson(FILES.build, { state: "idle" });
    if (b.state === "running") { try { process.kill(b.pid, 0); } catch { return { ...b, state: "failed", error: "Birleştirme süreci beklenmedik biçimde sonlandı." }; } }
    return b;
  };
  const tail = (f, n = 6) => { try { return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; } };

  // ffmpeg kare çıkarma, aynı anda en fazla 2 (render varken makineyi boğmasın)
  let active = 0;
  const waiting = [];
  const slot = () => new Promise((res) => { if (active < 2) { active++; res(); } else waiting.push(res); });
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  // ── HLG önizleme rengi ──
  // Projenin kendi HLG→SDR görüntüleme LUT'u (work/luts/hlg_to_sdr709_preview.cube; Studio proxy'si ve QC aynısını kullanır).
  // Ölçüm (SDR kareyi 08-assemble yoluyla HLG'ye yükselt → geri çevir → orijinalle PSNR): eski eq=contrast/saturation 21,0–21,5 dB, LUT 26,3–26,8 dB.
  // LUT 64 MB: her ffmpeg başlangıcında ~1,7 sn ayrıştırma → yalnız proxy parçalarında kullanılır; proxy'siz kaynaktan küçük resimler hızlı eq yaklaşığında kalır.
  const LUT_PREVIEW = p("work/luts/hlg_to_sdr709_preview.cube");
  let lutPromise = null;
  const lutReady = () => (lutPromise ??= new Promise((resolve) => { // yoksa 40-make-luts ile bir kez üretilir (betik yoksa → null → eq yedeği)
    if (existsSync(LUT_PREVIEW)) return resolve(LUT_PREVIEW);
    if (!existsSync(p("scripts/40-make-luts.mjs"))) return resolve(null);
    const c = spawn(process.execPath, [p("scripts/40-make-luts.mjs")], { cwd: ROOT, stdio: "ignore", windowsHide: true });
    c.on("error", () => resolve(null));
    c.on("exit", () => resolve(existsSync(LUT_PREVIEW) ? LUT_PREVIEW : null));
  }));
  const SWS = "flags=accurate_rnd+full_chroma_int";
  const escLut = (f) => f.replace(/\\/g, "/").replace(/([:'])/g, "\\$1");
  const EQ_FALLBACK = "eq=contrast=1.12:saturation=1.25,scale=640:-2,format=yuv420p";
  const hlgProxyFilter = (lut) => (lut
    ? `scale=640:-2:flags=bicubic,scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:${SWS},format=gbrp16le,lut3d=file='${escLut(lut)}':interp=tetrahedral,scale=out_color_matrix=bt709:out_range=tv:${SWS},format=yuv420p`
    : EQ_FALLBACK);

  // ── oynatma proxy'si: 640 px H.264, 60 sn'lik parçalar (yalnız önizleme; teslim hattına girmez) ──
  // Parçalar sırayla kuyruğa girer, 1–2 ffmpeg paralel çalışır; ilk parça hazır olunca oynatma başlayabilir.
  const chunkPath = (id, k) => path.join(FILES.proxies, id, `c${k}.mp4`);
  const chunksOf = (f) => Array.from({ length: chunkCount(f.duration) }, (_, k) => existsSync(chunkPath(f.id, k)));
  const jobs = new Map(); // id → { state: "building" | "failed", pending, error? }
  const queue = [];
  let encActive = 0;
  // işçi sayısı: VARSAYILAN 1. Ölçüm (5 dk 14 sn 4K HEVC, RTX 3050 Ti laptop): 2 işçi toplamı yalnız 123→115 sn yapıyor (%7; çözme tek GPU motoruna bağlı),
  // ama RAM 2,5 GB'a çıkıyor ve ilk parça 21 yerine 44 sn'de geliyor. KURGU_PROXY_WORKERS=2..4 ile artırılabilir (boş RAM 2,5 GB altındaysa yine 1).
  const WANT_WORKERS = Math.max(1, Math.min(4, Number(process.env.KURGU_PROXY_WORKERS) || 1));
  const workers = () => (os.freemem() < 2.5e9 ? 1 : WANT_WORKERS);
  /** Tek parça ffmpeg çalıştırması. hw=true: -hwaccel auto (Windows'ta d3d11va); başarısızsa çağıran yazılımla yeniden dener. */
  const encode = (f, k, tmp, hw, lut) => new Promise((resolve) => {
    const vf = f.kind === "hlg" ? hlgProxyFilter(lut) : "scale=640:-2,format=yuv420p";
    const args = ["-v", "error", "-y", ...(hw ? ["-hwaccel", "auto"] : []), "-ss", String(k * PROXY_CHUNK), "-t", String(PROXY_CHUNK), "-i", f.path, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-g", "15", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", tmp];
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-400); });
    child.on("error", (e) => resolve({ ok: false, msg: e.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, msg: err.trim().split("\n").pop() || `ffmpeg çıkış kodu ${code}` }));
  });
  const runChunk = async ({ f, k }) => {
    const st = jobs.get(f.id);
    if (!st || st.state === "failed") { pump(); return; } // iptal/hatalı dosyanın kalan parçaları atlanır
    encActive++;
    mkdirSync(path.dirname(chunkPath(f.id, k)), { recursive: true });
    const out = chunkPath(f.id, k), tmp = `${out}.partial.mp4`;
    const lut = f.kind === "hlg" ? await lutReady() : null;
    let res = await encode(f, k, tmp, true, lut);
    if (!res.ok) res = await encode(f, k, tmp, false, lut); // donanım çözme bu dosyada/makinede çalışmadı → yazılım
    encActive--;
    if (res.ok) {
      try { renameSync(tmp, out); st.pending -= 1; if (st.pending <= 0) jobs.delete(f.id); } catch (e) { jobs.set(f.id, { state: "failed", error: e.message }); }
    } else jobs.set(f.id, { state: "failed", error: res.msg });
    pump();
  };
  const pump = () => { while (encActive < workers() && queue.length) runChunk(queue.shift()); };
  const startProxy = (f) => {
    if (f.kind === "audio" || jobs.get(f.id)?.state === "building") return;
    const done = chunksOf(f);
    const missing = done.map((d, k) => (d ? -1 : k)).filter((k) => k >= 0);
    if (!missing.length) return;
    jobs.set(f.id, { state: "building", pending: missing.length });
    for (const k of missing) queue.push({ f, k });
    pump();
  };
  const proxyState = (f) => {
    if (f.kind === "audio") return "none";
    if (chunksOf(f).every(Boolean)) return "ready";
    return jobs.get(f.id)?.state ?? "missing";
  };

  const post = {
    "/api/montage/proxy": (b) => {
      const f = readBin().files.find((x) => x.id === b.id);
      if (!f) return [404, { error: "Dosya kutuda yok." }];
      if (jobs.get(f.id)?.state === "failed") jobs.delete(f.id); // yeniden dene
      startProxy(f);
      return [200, { ok: true, proxy: proxyState(f) }];
    },
    "/api/montage/state": () => [200, state()],
    "/api/montage/save": (b) => {
      if (!b.model || !Array.isArray(b.model.clips) || !Array.isArray(b.model.tracks)) return [422, { error: "Geçersiz timeline." }];
      const known = new Set(readBin().files.map((f) => f.path));
      const bad = b.model.clips.find((c) => !known.has(path.resolve(ROOT, c.src)));
      if (bad) return [422, { error: `"${bad.label}" klip kutusunda kayıtlı değil.` }];
      writeJson(FILES.model, { model: b.model, savedAt: new Date().toISOString() });
      return [200, { ok: true }];
    },
    "/api/montage/add": (b) => {
      const raw = String(b.path ?? "").trim().replace(/^"|"$/g, "");
      if (!raw) return [422, { error: "Dosya yolu boş." }];
      const abs = path.resolve(raw);
      if (!existsSync(abs) || !statSync(abs).isFile()) return [404, { error: "Dosya bulunamadı." }];
      if (!VIDEO_EXT.has(path.extname(abs).toLowerCase()) && !AUDIO_EXT.has(path.extname(abs).toLowerCase())) return [422, { error: "Video ya da ses dosyası değil (mp4, mov, mkv, m4v, webm, avi, mts, mp3, wav, m4a, aac, flac, ogg, aif)." }];
      const rel = path.relative(ROOT, abs);
      if (path.isAbsolute(rel)) return [422, { error: "Dosya proje ile aynı sürücüde olmalı (assemble göreli yol kullanır)." }];
      const bin = readBin();
      const existing = bin.files.find((f) => f.path === abs);
      if (existing) return [200, { ok: true, file: existing }];
      let info;
      try { info = probeFile(abs); } catch (e) { return [422, { error: String(e.message).split("\n")[0] }]; }
      const file = { id: createHash("sha1").update(abs).digest("hex").slice(0, 10), path: abs, src: rel.replace(/\\/g, "/"), name: path.basename(abs), size: statSync(abs).size, ...info };
      bin.files.push(file);
      writeJson(FILES.bin, bin);
      startProxy(file);
      return [200, { ok: true, file }];
    },
    "/api/montage/remove": (b) => {
      const bin = readBin();
      const model = readJson(FILES.model)?.model;
      const f = bin.files.find((x) => x.id === b.id);
      if (!f) return [404, { error: "Dosya kutuda yok." }];
      if (model?.clips.some((c) => path.resolve(ROOT, c.src) === f.path)) return [409, { error: "Dosya timeline'da kullanılıyor." }];
      bin.files = bin.files.filter((x) => x.id !== b.id);
      writeJson(FILES.bin, bin);
      return [200, { ok: true }];
    },
    "/api/montage/build": (b) => {
      if (jobRunning()) return [409, { error: "Render çalışırken birleştirme başlatılamaz." }];
      if (readBuild().state === "running") return [409, { error: "Birleştirme zaten çalışıyor." }];
      if (!b.model) return [422, { error: "Timeline gönderilmedi." }];
      let spec, sel;
      try { spec = toAssemble(b.model); sel = toSelection(b.model); } catch (e) { return [422, { error: e.message }]; }
      if (sel && !readBin().files.some((f) => f.path === path.resolve(ROOT, sel.music) && f.kind === "audio")) return [422, { error: "Müzik klibi kutuda kayıtlı bir ses dosyası değil." }];
      const known = new Set(readBin().files.map((f) => f.path));
      const bad = spec.pieces.find((pc) => !known.has(path.resolve(ROOT, pc.src)));
      if (bad) return [422, { error: `Klip kutusunda kayıtlı olmayan kaynak: ${bad.src}` }];
      writeJson(FILES.model, { model: b.model, savedAt: new Date().toISOString() });
      writeJson(p("work/assemble.json"), spec);
      writeJson(p("work/montage-audio.json"), sel ?? { music: null }); // runner bunu work/audio/selection.json'a birleştirir
      mkdirSync(p("work/logs"), { recursive: true });
      const log = openSync(p("work/logs/assemble.log"), "w");
      const child = spawn(process.execPath, [p("scripts/run-assemble-detached.mjs"), "--child"], { cwd: ROOT, detached: true, stdio: ["ignore", log, log], windowsHide: true });
      child.unref();
      writeJson(FILES.build, { state: "running", pid: child.pid, startedAt: new Date().toISOString(), pieces: spec.pieces.length });
      return [200, { ok: true }];
    },
  };

  const state = () => {
    const saved = readJson(FILES.model);
    const build = readBuild();
    return { model: saved?.model ?? null, savedAt: saved?.savedAt ?? null, bin: readBin().files.map((f) => ({ ...f, proxy: proxyState(f), proxyError: jobs.get(f.id)?.error, chunks: f.kind === "audio" ? null : chunksOf(f) })), build: { ...build, log: build.state === "running" ? tail(p("work/logs/assemble.log")) : [] } };
  };

  /** GET: /api/montage (durum), /api/montage/thumb?id&t&w (JPEG kare). true = işlendi. */
  const get = async (url, req, res) => {
    if (url.pathname === "/api/montage") { send(res, 200, state()); return true; }
    if (url.pathname === "/api/montage/media") { // oynatma: video → proxy dosyası, ses → özgün dosya (yalnız kayıtlı kimlikler)
      const f = readBin().files.find((x) => x.id === url.searchParams.get("id"));
      const k = Number(url.searchParams.get("chunk"));
      const file = f && (f.kind === "audio" ? f.path : Number.isInteger(k) && k >= 0 ? chunkPath(f.id, k) : null);
      if (!file || !existsSync(file)) { send(res, 404, { error: "yok" }); return true; }
      serveFile(req, res, file);
      return true;
    }
    if (url.pathname === "/api/montage/wave") { // ses dosyasının tepe değerleri (20 örnek/sn, 0–100); önbelleğe yazılır
      const f = readBin().files.find((x) => x.id === url.searchParams.get("id"));
      if (!f || !existsSync(f.path)) { send(res, 404, { error: "yok" }); return true; }
      const cache = path.join(FILES.waves, `${f.id}.json`);
      if (!existsSync(cache)) {
        mkdirSync(FILES.waves, { recursive: true });
        await slot();
        try {
          const buf = execFileSync("ffmpeg", ["-v", "error", "-i", f.path, "-map", "0:a:0", "-ac", "1", "-ar", "4000", "-f", "f32le", "-"], { maxBuffer: 1 << 29, windowsHide: true, timeout: 120000 });
          writeFileSync(cache, JSON.stringify(wavePeaks(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4), 4000, 20)));
        } catch { send(res, 500, { error: "Dalga formu çıkarılamadı." }); release(); return true; }
        release();
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" });
      res.end(readFileSync(cache));
      return true;
    }
    if (url.pathname !== "/api/montage/thumb") return false;
    const f = readBin().files.find((x) => x.id === url.searchParams.get("id"));
    if (!f || !existsSync(f.path)) { send(res, 404, { error: "yok" }); return true; }
    const t = Math.min(Math.max(0, Number(url.searchParams.get("t")) || 0), Math.max(0, f.duration - 0.1));
    const w = Math.min(960, Math.max(48, Math.round(Number(url.searchParams.get("w")) || 160)));
    // proxy hazırsa küçük resimler ondan çıkar (4K HEVC'den ~2 sn, proxy'den ~0,06 sn); HLG düzeltmesi proxy'de zaten var
    const ck = chunkIndex(t), viaProxy = w <= 640 && f.kind !== "audio" && existsSync(chunkPath(f.id, ck));
    const cache = path.join(FILES.thumbs, `${f.id}-${Math.round(t * 10)}-${w}${viaProxy ? "-p" : ""}.jpg`);
    if (!existsSync(cache)) {
      mkdirSync(FILES.thumbs, { recursive: true });
      await slot();
      try {
        // HLG kaynak düz görünür; önizleme için kabaca SDR'a çekilir (yalnız bakmak için, teslime girmez)
        const vf = `${!viaProxy && f.kind === "hlg" ? "eq=contrast=1.12:saturation=1.25," : ""}scale=${w}:-2`;
        execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", (viaProxy ? t - ck * PROXY_CHUNK : t).toFixed(3), "-i", viaProxy ? chunkPath(f.id, ck) : f.path, "-frames:v", "1", "-vf", vf, "-q:v", "5", cache], { windowsHide: true, timeout: 30000 });
      } catch { send(res, 500, { error: "Kare çıkarılamadı." }); release(); return true; }
      release();
    }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=3600" });
    res.end(readFileSync(cache));
    return true;
  };

  return { post, get };
}
