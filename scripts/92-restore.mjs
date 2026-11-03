// Video restorasyonu: gürültü giderme + çözünürlük yükseltme (upscale) + kare hızı artırma (frame interpolation).
// Bağımsız çalışır: herhangi bir videoyu alır, out/restore/ altına yeni dosya yazar. Kaynağa DOKUNMAZ.
//
//   npm run restore -- --in eski.mp4                       (varsayılan: 4K, orta gürültü giderme, kare hızı aynı)
//   npm run restore -- --in eski.mp4 --height 1440 --fps 60 --denoise strong --engine ai
//   npm run restore -- --in eski.mp4 --start 10 --dur 8    (8 sn'lik ÖNİZLEME: önce bunu dene)
//   npm run restore -- --doctor                            (araç/disk/GPU durumu)
//
// --engine classic : yalnız ffmpeg (nlmeans/hqdn3d + lanczos + minterpolate). Hızlı, ek kurulum yok, disk kullanmaz.
// --engine ai      : Real-ESRGAN (upscale) + RIFE (ara kare), ncnn-vulkan. Yavaş, çok daha iyi detay, ara diske kare yazar.
// --engine auto    : araçlar kuruluysa ai, değilse classic.
//
// Devam: hata/kesinti olursa ara parçalar kalır; AYNI komutu tekrar çalıştırmak kaldığı yerden devam eder (--fresh: sıfırdan).
// Ölçüm: bitince sn/kare %LOCALAPPDATA%\KurguAtolyesi\restore-rates.json'a yazılır; sonraki aynı ayarda süre tahmini verilir.
// --chunk N : parça başına en fazla N kare (varsayılan: disk ve 10 sn'ye göre otomatik; yalnız küçültür).
//
// Dürüst beklenti: bu, Topaz seviyesinde bir ürün değil; yerel GPU (4 GB) ve açık modellerle yapılan en iyi çaba.
// Yapay zekâ upscale yüzlerde/yazılarda "uydurma" detay üretebilir; arşiv/belgesel işinde önizlemeyi gözle kontrol et.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, p } from "./lib/paths.mjs";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

export const TOOLS = process.env.RESTORE_TOOLS ?? path.join(os.homedir(), "_tools", "restore");
const exe = (dir, name) => path.join(TOOLS, dir, process.platform === "win32" ? `${name}.exe` : name);
export const ESRGAN = exe("realesrgan", "realesrgan-ncnn-vulkan");
const rifeDir = () => {
  if (!existsSync(TOOLS)) return null;
  const d = readdirSync(TOOLS).find((n) => n.startsWith("rife-ncnn-vulkan"));
  return d ? path.join(TOOLS, d) : null;
};
export const RIFE = () => { const d = rifeDir(); return d ? path.join(d, process.platform === "win32" ? "rife-ncnn-vulkan.exe" : "rife-ncnn-vulkan") : null; };

const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...o });
const freeBytes = (dir) => { const s = statfsSync(dir); return s.bavail * s.bsize; };
const GiB = 2 ** 30;

// ---------- saf yardımcılar (testlenebilir) ----------
export const DENOISE = {
  off: null,
  light: "hqdn3d=2:1.5:3:2.5",
  medium: "nlmeans=s=3:p=5:r=11",
  strong: "nlmeans=s=6:p=5:r=15,hqdn3d=1:1:4:4",
};
export function parseRate(r) { const [n, d = 1] = String(r).split("/").map(Number); return d ? n / d : 0; }
/** "none" | "2x" | "3x" | "60" -> hedef fps (sayı) ya da null (değiştirme) */
export function targetFps(spec, srcFps) {
  if (!spec || spec === "none") return null;
  const m = /^(\d+(?:\.\d+)?)x$/.exec(spec);
  if (m) return +(srcFps * Number(m[1])).toFixed(3);
  const n = Number(spec);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Geçersiz --fps: ${spec} (none, 2x, 3x ya da 50/60 gibi sayı)`);
  return n > srcFps + 0.01 ? n : null; // fps düşürmek restorasyon değil
}
/** En-boy oranını koruyarak hedef yüksekliğe ölçek; genişlik çift sayı. Küçültme yok. */
export function targetSize(w, h, height) {
  const H = Math.max(h, Math.round(height / 2) * 2);
  const W = Math.round((w * H) / h / 2) * 2;
  return { W, H, factor: H / h };
}
/** ESRGAN modeli 4x sabit; 2x'ten az gerekiyorsa yine 4x çalışıp ffmpeg ile aşağı ölçeriz. */
export function chunkFrames(freeB, bytesPerFrame, reserveGiB = 1) {
  const usable = Math.max(0, freeB - reserveGiB * GiB) * 0.6;
  return Math.max(0, Math.min(600, Math.floor(usable / bytesPerFrame)));
}

/** Model adından ölçek: "...-x2" → 2, "realesrgan-x4plus" → 4. */
export function modelScale(model) { const m = /(?:x(\d)(?:plus)?(?:-anime)?|-(\d)x)$/.exec(model); return m ? Number(m[1] ?? m[2]) : 4; }
/** Klasördeki numaralı PNG dizisinin ffmpeg kalıbı (RIFE 8 hane, bizim çıkarım 6 hane üretir). */
export function frameSequence(dir) {
  const names = readdirSync(dir).filter((n) => /^\d+\.png$/i.test(n)).sort();
  if (!names.length) return null;
  const digits = names[0].match(/^(\d+)/)[1];
  return { pattern: path.join(dir, `%0${digits.length}d.png`), start: Number(digits), count: names.length };
}

// ---------- ölçüm ve devam (resume) yardımcıları ----------
/** Panel ile aynı veri klasörü (KURGU_DATA ya da %LOCALAPPDATA%\KurguAtolyesi). */
export const dataDir = () => process.env.KURGU_DATA ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local/share"), "KurguAtolyesi");
export const ratesFile = () => path.join(dataDir(), "restore-rates.json");
/** Hız anahtarı: model + kaynak→hedef boyut + ara kare katı. Aynı ayarlar aynı hızı verir. */
export function rateKey({ model, src, size, interp = 1 }) { return `${model}|${src.w}x${src.h}>${size.W}x${size.H}|x${interp}`; }
/** Ölçülmüş sn/kare ile kalan süreyi hesaplar; ölçüm yoksa null (uydurma tahmin yok). */
export function estimateSeconds(rate, frames) { return rate && rate.secPerFrame > 0 ? rate.secPerFrame * frames : null; }
export function loadRates(file = ratesFile()) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } }
export function saveRate(key, secPerFrame, frames, file = ratesFile()) {
  try {
    const all = loadRates(file);
    all[key] = { secPerFrame: +secPerFrame.toFixed(4), frames, at: new Date().toISOString() };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2));
  } catch { /* ölçüm kaydı yardımcıdır; yazılamazsa iş bozulmaz */ }
}
/** Aynı girdi + aynı ayarlar → aynı iş klasörü; ayar değişirse eski parçalarla karışmaz. */
export function workKey(parts) { return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 10); }
export const fmtMin = (sec) => (sec >= 90 ? `${(sec / 60).toFixed(1)} dk` : `${Math.round(sec)} sn`);
/** Çıktının kare sayısı beklenenle aynı mı? (HEVC'de paket sayısı = kare sayısı; dekode etmeden hızlıdır.) */
export function frameCountMatches(actual, expected, tolerance = 1) { return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance; }

export function probe(file) {
  const j = JSON.parse(run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]));
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("Videoda görüntü akışı yok");
  const fps = parseRate(v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate);
  const interlaced = v.field_order && !["progressive", "unknown"].includes(v.field_order);
  return { w: v.width, h: v.height, fps, duration: Number(j.format.duration), interlaced, pixFmt: v.pix_fmt, hasAudio: j.streams.some((s) => s.codec_type === "audio"), hdr: /smpte2084|arib-std-b67/.test(v.color_transfer ?? "") };
}

function doctor() {
  const rows = [];
  const ok = (name, good, note = "") => rows.push(`${good ? "✔" : "✘"} ${name}${note ? "  — " + note : ""}`);
  for (const t of ["ffmpeg", "ffprobe"]) { try { run(t, ["-version"]); ok(t, true); } catch { ok(t, false, "PATH'te yok"); } }
  ok("Real-ESRGAN (upscale)", existsSync(ESRGAN), existsSync(ESRGAN) ? ESRGAN : `kurulu değil: ${TOOLS}\\realesrgan`);
  ok("RIFE (ara kare)", !!RIFE() && existsSync(RIFE()), RIFE() ?? `kurulu değil: ${TOOLS}\\rife-ncnn-vulkan-*`);
  try {
    const f = run("ffmpeg", ["-hide_banner", "-filters"]);
    ok("nlmeans", /nlmeans/.test(f)); ok("minterpolate", /minterpolate/.test(f));
  } catch {}
  try { ok("GPU", true, run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]).trim()); } catch { ok("GPU (nvidia-smi)", false); }
  mkdirSync(p("out/restore"), { recursive: true });
  const free = freeBytes(ROOT);
  ok("Disk", free > 5 * GiB, `${(free / GiB).toFixed(1)} GiB boş (AI modunda ara kareler için ≥5 GiB önerilir)`);
  console.log(rows.join("\n"));
}

// ---------- ffmpeg filtre zinciri ----------
export function buildChain({ src, size, denoise, fps, engine }) {
  const f = [];
  if (src.interlaced) f.push("bwdif=mode=send_frame:parity=auto:deint=all");
  if (DENOISE[denoise]) f.push(DENOISE[denoise]);
  if (engine === "classic") {
    if (fps) f.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
    if (size.factor > 1.001) f.push(`scale=${size.W}:${size.H}:flags=lanczos+accurate_rnd+full_chroma_int`, "unsharp=5:5:0.6:5:5:0.0");
  }
  return f;
}

function encodeArgs(out, src, fps, crf) {
  const a = ["-c:v", "libx265", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-x265-params", "log-level=error"];
  a.push(...(src.hasAudio ? ["-c:a", "copy"] : ["-an"]), "-movflags", "+faststart");
  return a;
}

function ffmpegProgress(args, totalSec, label) {
  return new Promise((resolve, reject) => {
    const c = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    c.stdout.on("data", (d) => {
      buf += d;
      const m = [...buf.matchAll(/out_time_ms=(\d+)/g)].pop();
      if (m && totalSec) process.stdout.write(`\r${label} %${Math.min(99, (Number(m[1]) / 1e6 / totalSec) * 100).toFixed(1)}   `);
      if (buf.length > 4096) buf = buf.slice(-1024);
    });
    c.on("exit", (code) => { process.stdout.write("\n"); code === 0 ? resolve() : reject(new Error(`ffmpeg çıkış kodu ${code}`)); });
  });
}

// ---------- classic: tek geçiş, ara disk yok ----------
async function classic({ input, out, src, size, denoise, fps, crf, start, dur }) {
  const chain = buildChain({ src, size, denoise, fps, engine: "classic" });
  const total = dur ?? (src.duration - (start ?? 0));
  const args = ["-y", ...(start ? ["-ss", String(start)] : []), ...(dur ? ["-t", String(dur)] : []), "-i", input, ...(chain.length ? ["-vf", chain.join(",")] : []), ...encodeArgs(out, src, fps, crf), out];
  await ffmpegProgress(args, total, "classic");
}

// ---------- ai: parçalı (chunk) işleme; ara kareler sınırlı diske yazılır ----------
/** Alt süreci asenkron çalıştırır; `watchDir` içindeki PNG sayısını periyodik bildirir (parça içi ilerleme). */
function runWatched(cmd, args, { cwd, watchDir, onTick }) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const timer = setInterval(() => { try { onTick(readdirSync(watchDir).filter((n) => /\.png$/i.test(n)).length); } catch { /* klasör henüz yok */ } }, 2000);
    c.on("error", (e) => { clearInterval(timer); reject(e); });
    c.on("exit", (code) => { clearInterval(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} çıkış kodu ${code}: ${err.trim().split("\n").pop() ?? ""}`)); });
  });
}

async function ai({ input, out, src, size, denoise, fps, crf, start, dur, tmpRoot }) {
  const rife = RIFE();
  const needRife = !!fps;
  if (!existsSync(ESRGAN)) throw new Error("Real-ESRGAN kurulu değil (npm run restore -- --doctor).");
  if (needRife && !(rife && existsSync(rife))) throw new Error("RIFE kurulu değil; ya --fps none verin ya da kurun (npm run restore -- --doctor).");
  const interpFactor = needRife ? Math.max(2, Math.round(fps / src.fps)) : 1; // RIFE tam katlar üretir
  const outFps = src.fps * interpFactor;
  if (needRife && Math.abs(outFps - fps) > 0.5) console.log(`ℹ RIFE yalnız tam katlar üretir: ${fps} yerine ${outFps} fps.`);
  const model = opt("--model", "upscayl-lite-4x");
  const bytesPerFrame = size.W * size.H * 3 * 0.9 + src.w * src.h * 3 * 0.9 * (1 + interpFactor); // PNG kabaca
  const free = freeBytes(tmpRoot);
  let nChunk = Math.max(0, Math.min(chunkFrames(free, bytesPerFrame), Math.round(src.fps * 10)));
  if (opt("--chunk")) nChunk = Math.max(1, Math.min(nChunk, Math.floor(Number(opt("--chunk"))))); // test/ince ayar: parçayı küçültür, büyütemez
  if (nChunk < 8) throw new Error(`Disk yetersiz: ${(free / GiB).toFixed(1)} GiB boş, ${size.W}x${size.H} için parça başına ≥8 kare gerekir. Yer açın ya da --tmp ile başka sürücü verin.`);
  const totalDur = dur ?? (src.duration - (start ?? 0));
  const totalFrames = Math.floor(totalDur * src.fps);

  // Aynı girdi + ayar → aynı iş klasörü. Hata olursa parçalar KALIR; aynı komut kaldığı yerden devam eder.
  const st = statSync(input);
  const work = path.join(tmpRoot, `restore-${workKey({ input: path.resolve(input), mtime: st.mtimeMs, bytes: st.size, model, W: size.W, H: size.H, denoise, outFps, start: start ?? 0, dur: dur ?? null })}`);
  if (flag("--fresh")) rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const metaFile = path.join(work, "meta.json");
  if (existsSync(metaFile)) nChunk = JSON.parse(readFileSync(metaFile, "utf8")).nChunk; // parça sınırları ilk çalıştırmadaki gibi kalmalı
  else writeFileSync(metaFile, JSON.stringify({ nChunk }));

  const key = rateKey({ model, src, size, interp: interpFactor });
  const est = estimateSeconds(loadRates()[key], totalFrames);
  console.log(`AI modu: ${totalFrames} kare, parça başına ${nChunk} kare, ${interpFactor}x ara kare, model ${model}`);
  console.log(est ? `Tahmini süre: ~${fmtMin(est)} (bu bilgisayarda bu ayarın son ölçümüne göre)` : "Tahmini süre: bu ayar için ölçüm yok; ilk çalıştırmadan sonra kaydedilir.");
  const parts = [];
  const t0 = Date.now();
  let processed = 0; // bu çalıştırmada gerçekten işlenen kare (devam edilenler sayılmaz)
  const say = (done) => {
    const el = (Date.now() - t0) / 1000;
    const left = processed > 0 ? `  kalan ~${fmtMin((el / Math.max(1, processed)) * (totalFrames - done))}` : "";
    process.stdout.write(`\rai %${((done / totalFrames) * 100).toFixed(1)}  geçen ${fmtMin(el)}${left}      `);
  };
  try {
    for (let i = 0, k = 0; i < totalFrames; i += nChunk, k++) {
      const n = Math.min(nChunk, totalFrames - i);
      const part = path.join(work, `part-${String(k).padStart(4, "0")}.mkv`);
      if (existsSync(part)) { parts.push(part); console.log(`parça ${k + 1} hazır, atlanıyor`); continue; }
      const ts = (start ?? 0) + i / src.fps;
      const dIn = path.join(work, "in"), dRife = path.join(work, "rife"), dUp = path.join(work, "up");
      for (const d of [dIn, dRife, dUp]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d); }
      const pre = [src.interlaced && "bwdif=mode=send_frame:parity=auto:deint=all", DENOISE[denoise]].filter(Boolean);
      run("ffmpeg", ["-v", "error", "-y", "-ss", String(ts), "-i", input, "-frames:v", String(n), ...(pre.length ? ["-vf", pre.join(",")] : []), path.join(dIn, "%06d.png")]);
      let upIn = dIn;
      if (needRife) { // ara kareler DÜŞÜK çözünürlükte üretilir (4 GB VRAM'e sığar, ESRGAN'dan çok daha ucuz)
        run(rife, ["-i", dIn, "-o", dRife, "-m", "rife-v4.6", "-n", String(n * interpFactor)], { cwd: path.dirname(rife) });
        upIn = dRife;
      }
      const base = i;
      await runWatched(ESRGAN, ["-i", upIn, "-o", dUp, "-n", model, "-s", String(modelScale(model)), "-t", "128", "-f", "png"], {
        cwd: path.dirname(ESRGAN), watchDir: dUp,
        onTick: (count) => say(Math.min(totalFrames, base + Math.floor((count / (n * interpFactor)) * n))),
      });
      const seq = frameSequence(dUp);
      if (!seq) throw new Error(`Real-ESRGAN çıktı üretmedi (${dUp}). Model adı doğru mu? (--model ${model})`);
      const tmpPart = path.join(work, `part-${String(k).padStart(4, "0")}.partial.mkv`); // yarım dosya "hazır" sayılmasın
      run("ffmpeg", ["-v", "error", "-y", "-framerate", String(outFps), "-start_number", String(seq.start), "-i", seq.pattern, "-vf", `scale=${size.W}:${size.H}:flags=lanczos${src.hdr ? "" : ":out_color_matrix=bt709:out_range=tv"}`, ...(src.hdr ? [] : ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]), "-c:v", "libx265", "-preset", "fast", "-crf", "10", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error", tmpPart]);
      renameSync(tmpPart, part);
      parts.push(part);
      processed += n;
      say(Math.min(totalFrames, i + n));
    }
    process.stdout.write("\n");
    for (const d of ["in", "rife", "up"]) rmSync(path.join(work, d), { recursive: true, force: true });
    const list = path.join(work, "parts.txt");
    writeFileSync(list, parts.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
    // ses: orijinalden, aynı aralık; video: parçalar. Parçalar zaten x265 → yalnız yeniden paketle (crf 10 ≈ kayıpsız ara)
    const a = src.hasAudio ? ["-ss", String(start ?? 0), ...(dur ? ["-t", String(dur)] : []), "-i", input, "-map", "0:v", "-map", "1:a:0", "-c:a", "copy"] : ["-map", "0:v"];
    run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, ...(src.hasAudio ? a.slice(0) : []), ...(src.hasAudio ? [] : a), "-c:v", "copy", "-tag:v", "hvc1", "-shortest", "-movflags", "+faststart", out]);
  } catch (e) {
    process.stdout.write("\n");
    console.error(`ℹ Ara parçalar korundu (${work}). Aynı komutu tekrar çalıştırırsanız kaldığı yerden devam eder; sıfırdan başlamak için --fresh ekleyin.`);
    throw e;
  }
  rmSync(work, { recursive: true, force: true });
  if (processed >= 24) saveRate(key, (Date.now() - t0) / 1000 / processed, processed);
  // Çıktı gerçekten iddia edilen şeyi mi içeriyor? (paket sayısı = kare sayısı)
  const got = Number(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", out]).trim());
  const want = totalFrames * interpFactor;
  console.log(frameCountMatches(got, want) ? `✔ Kare sayısı doğrulandı: ${got}/${want}` : `⚠ Kare sayısı beklenenden farklı: ${got}, beklenen ${want}`);
}

// ---------- ana akış ----------
async function main() {
  if (flag("--doctor")) return doctor();
  const input = opt("--in");
  if (!input) { console.error("Kullanım: npm run restore -- --in video.mp4 [--height 2160] [--denoise off|light|medium|strong] [--fps none|2x|60] [--engine auto|classic|ai] [--start s --dur s] [--crf 14] [--chunk N] [--fresh] | --doctor"); process.exit(1); }
  if (!existsSync(input)) { console.error(`Dosya yok: ${input}`); process.exit(1); }
  const src = probe(input);
  if (src.hdr) console.log("⚠ HDR kaynak: restorasyon SDR/ton eşlemesi yapmaz; renkler değişebilir. HDR için çıktıyı gözle kontrol et.");
  const height = Number(opt("--height", 2160));
  const denoise = opt("--denoise", "medium");
  if (!(denoise in DENOISE)) { console.error(`Geçersiz --denoise: ${denoise}`); process.exit(1); }
  const fps = targetFps(opt("--fps", "none"), src.fps);
  const size = targetSize(src.w, src.h, height);
  let engine = opt("--engine", "auto");
  if (engine === "auto") engine = existsSync(ESRGAN) && (!fps || (RIFE() && existsSync(RIFE()))) ? "ai" : "classic";
  const start = opt("--start") ? Number(opt("--start")) : undefined;
  const dur = opt("--dur") ? Number(opt("--dur")) : undefined;
  const preview = dur !== undefined;
  const base = path.basename(input, path.extname(input));
  mkdirSync(p("out/restore"), { recursive: true });
  const out = path.resolve(opt("--out", p("out/restore", `${base}.${size.H}p${fps ? "." + fps + "fps" : ""}.${engine}${preview ? ".onizleme" : ""}.mp4`)));
  if (path.resolve(input) === out) { console.error("Çıktı kaynağın üstüne yazılamaz."); process.exit(1); }
  if (existsSync(out) && !flag("--overwrite")) { console.error(`Zaten var: ${out} (--overwrite ile değiştir)`); process.exit(1); }
  const crf = Number(opt("--crf", 14));
  console.log(`${src.w}x${src.h}@${src.fps.toFixed(3)} → ${size.W}x${size.H}${fps ? "@" + fps : ""} | gürültü: ${denoise} | motor: ${engine}${src.interlaced ? " | taramalı → bwdif" : ""}`);
  if (size.factor <= 1.001) console.log("ℹ Hedef yükseklik kaynaktan büyük değil; upscale yapılmayacak.");
  const t = Date.now();
  const ctx = { input, out, src, size, denoise, fps, crf, start, dur, tmpRoot: path.resolve(opt("--tmp", os.tmpdir())) };
  if (engine === "ai") await ai(ctx); else await classic(ctx);
  const outInfo = probe(out);
  console.log(`✔ ${out}\n  ${outInfo.w}x${outInfo.h}@${outInfo.fps.toFixed(3)}, ${(outInfo.duration).toFixed(1)} sn, ${((Date.now() - t) / 60000).toFixed(1)} dk`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main().catch((e) => { console.error("\n✘ " + e.message); process.exit(1); });
}
