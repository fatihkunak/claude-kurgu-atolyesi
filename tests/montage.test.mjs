// Montaj sunucu modülü: gerçek ffprobe/ffmpeg ile küçük sentetik kliplerde (birkaç sn, 320x180). Proje dosyalarına dokunmaz (geçici kök).
//   node --test tests/montage.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createMontage, wavePeaks } from "../studio/montage.mjs";
import { addClip, createModel, moveClips } from "../studio/timeline/engine.mjs";

let root, m, a, b;
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const hasX265 = (() => { try { return execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("libx265"); } catch { return false; } })();
const sent = {};
const served = {};
const fakeRes = () => ({ writeHead(code, h) { sent.code = code; sent.headers = h; }, end(body) { sent.body = body; } });

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "kurgu-montage-"));
  mkdirSync(path.join(root, "clips"), { recursive: true });
  a = path.join(root, "clips", "a.mp4");
  b = path.join(root, "clips", "b.mp4");
  if (hasFfmpeg) {
    for (const [f, rate] of [[a, 30], [b, 30]]) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=320x180:rate=${rate}:duration=3`, "-pix_fmt", "yuv420p", f]);
    }
  }
  const readJson = (f, fb = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } };
  const send = (res, code, body) => res.writeHead(code, {}) || res.end(body);
  m = createMontage({ p: (...x) => path.join(root, ...x), ROOT: root, readJson, send, jobRunning: () => false, serveFile: (req, res, file) => { served.file = file; res.writeHead(200, {}); res.end("ok"); } });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("Klip ekleme: ffprobe ile süre/kare hızı/tür okunur, tekrar eklemek aynı kaydı döndürür", { skip: !hasFfmpeg }, async () => {
  const [code, r] = await m.post["/api/montage/add"]({ path: a });
  assert.equal(code, 200);
  assert.ok(Math.abs(r.file.duration - 3) < 0.1);
  assert.equal(r.file.fps, 30);
  assert.equal(r.file.kind, "sdr");
  assert.equal(r.file.src, "clips/a.mp4");
  const [, again] = await m.post["/api/montage/add"]({ path: a });
  assert.equal(again.file.id, r.file.id);
});

test("Geçersiz yol / uzantı reddedilir", async () => {
  assert.equal((await m.post["/api/montage/add"]({ path: path.join(root, "yok.mp4") }))[0], 404);
  assert.equal((await m.post["/api/montage/add"]({ path: path.join(root, "clips") }))[0], 404);
  const txt = path.join(root, "x.txt");
  execFileSync(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(txt)}, 'x')`]);
  assert.equal((await m.post["/api/montage/add"]({ path: txt }))[0], 422);
});

test("Kayıt yalnız klip kutusundaki kaynaklarla; build boşluk ve kayıtsız kaynağı reddeder", { skip: !hasFfmpeg }, async () => {
  await m.post["/api/montage/add"]({ path: b });
  const bin = (await m.post["/api/montage/state"]())[1].bin;
  const fa = bin.find((f) => f.name === "a.mp4"), fb = bin.find((f) => f.name === "b.mp4");
  let model = createModel({ fps: 30 });
  ({ model } = addClip(model, { src: fa.src, srcOut: fa.duration, fileId: fa.id }));
  ({ model } = addClip(model, { src: fb.src, srcIn: 1, srcOut: 3, fileId: fb.id }));
  assert.equal((await m.post["/api/montage/save"]({ model }))[0], 200);
  const st = (await m.post["/api/montage/state"]())[1];
  assert.equal(st.model.clips.length, 2);
  // kayıtsız kaynak
  const rogue = { ...model, clips: model.clips.map((c, i) => (i ? { ...c, src: "../../etc/passwd.mp4" } : c)) };
  assert.equal((await m.post["/api/montage/save"]({ model: rogue }))[0], 422);
  assert.equal((await m.post["/api/montage/build"]({ model: rogue }))[0], 422);
  // boşluk
  const gap = moveClips(model, [model.clips[1].id], 1);
  const [code, err] = await m.post["/api/montage/build"]({ model: gap });
  assert.equal(code, 422);
  assert.match(err.error, /boşluk/);
  // kutudan kaldırma: kullanımdaysa reddedilir
  assert.equal((await m.post["/api/montage/remove"]({ id: fa.id }))[0], 409);
});

test("Kare önizleme: JPEG üretir, önbelleğe yazar, bilinmeyen kimlik 404", { skip: !hasFfmpeg }, async () => {
  const bin = (await m.post["/api/montage/state"]())[1].bin;
  const id = bin[0].id;
  const url = new URL(`http://x/api/montage/thumb?id=${id}&t=1.0&w=160`);
  const res = fakeRes();
  assert.equal(await m.get(url, {}, res), true);
  assert.equal(sent.code, 200);
  assert.equal(sent.headers["content-type"], "image/jpeg");
  assert.ok(Buffer.isBuffer(sent.body) && sent.body[0] === 0xff && sent.body[1] === 0xd8, "JPEG imzası");
  assert.ok(existsSync(path.join(root, "work/montage-thumbs", `${id}-10-160.jpg`)));
  await m.get(new URL("http://x/api/montage/thumb?id=bilinmiyor&t=0"), {}, fakeRes());
  assert.equal(sent.code, 404);
});

test("Renk türü: HLG 'hlg' okunur, PQ (HDR10) reddedilir", { skip: !hasFfmpeg || !hasX265 }, async () => {
  const enc = (name, trc) => {
    const f = path.join(root, "clips", name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast",
      "-x265-params", `log-level=error:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc`, f]);
    return f;
  };
  const hlg = await m.post["/api/montage/add"]({ path: enc("hlg.mp4", "arib-std-b67") });
  assert.equal(hlg[0], 200);
  assert.equal(hlg[1].file.kind, "hlg");
  const pq = await m.post["/api/montage/add"]({ path: enc("pq.mp4", "smpte2084") });
  assert.equal(pq[0], 422);
  assert.match(pq[1].error, /PQ/);
});

test("Ses dosyası (müzik): kind 'audio' okunur; ses izine kayıtlı müzik klibi build'e hazır; ikinci müzik klibi reddedilir", { skip: !hasFfmpeg }, async () => {
  const wav = path.join(root, "clips", "muzik.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-ar", "44100", wav]);
  const [code, r] = await m.post["/api/montage/add"]({ path: wav });
  assert.equal(code, 200);
  assert.equal(r.file.kind, "audio");
  assert.equal(r.file.fps, null);
  assert.ok(Math.abs(r.file.duration - 20) < 0.1);
  const bin = (await m.post["/api/montage/state"]())[1].bin;
  const fa = bin.find((f) => f.name === "a.mp4");
  let model = createModel({ fps: 30 });
  ({ model } = addClip(model, { src: fa.src, srcOut: fa.duration, fileId: fa.id }));
  ({ model } = addClip(model, { trackId: "A1", src: r.file.src, srcIn: 2, srcOut: 12, kind: "audio", fileId: r.file.id }, { at: 1 }));
  assert.equal((await m.post["/api/montage/save"]({ model }))[0], 200);
  // ikinci müzik klibi → toSelection hata verir
  ({ model } = addClip(model, { trackId: "A1", src: r.file.src, srcOut: 3, kind: "audio", fileId: r.file.id }, { at: 15 }));
  const [c2, e2] = await m.post["/api/montage/build"]({ model });
  assert.equal(c2, 422);
  assert.match(e2.error, /tek müzik klibi/);
  // kutuda ses olarak kayıtlı olmayan "müzik" (video dosyası ses izine konmuş)
  let bad = createModel({ fps: 30 });
  ({ model: bad } = addClip(bad, { src: fa.src, srcOut: fa.duration, fileId: fa.id }));
  ({ model: bad } = addClip(bad, { trackId: "A1", src: fa.src, srcOut: 2, kind: "audio" }));
  const [c3, e3] = await m.post["/api/montage/build"]({ model: bad });
  assert.equal(c3, 422);
  assert.match(e3.error, /ses dosyası değil/);
});

test("wavePeaks: bin/sn'ye indirir, en büyük tepe 100, sessizlik 0", () => {
  const sr = 100, x = new Float32Array(300); // 3 sn
  x[150] = 0.5; x[250] = -0.25; // 1,5 sn ve 2,5 sn
  const w = wavePeaks(x, sr, 10); // 10 bin/sn → 30 bin
  assert.equal(w.perSec, 10);
  assert.equal(w.peaks.length, 30);
  assert.equal(w.peaks[15], 100);
  assert.equal(w.peaks[25], 50);
  assert.equal(w.peaks[0], 0);
  assert.deepEqual(wavePeaks(new Float32Array(100), sr, 10).peaks.every((v) => v === 0), true);
});

test("Proxy ve medya: video proxy'si üretilir (state 'ready'), /media proxy dosyasını, ses özgün dosyayı sunar; bilinmeyen kimlik 404; dalga formu önbelleğe yazılır", { skip: !hasFfmpeg }, async () => {
  const bin = () => m.post["/api/montage/state"]()[1].bin;
  const fb = bin().find((f) => f.name === "b.mp4");
  for (let i = 0; i < 120 && bin().find((f) => f.id === fb.id).proxy !== "ready"; i++) await new Promise((r) => setTimeout(r, 500));
  assert.equal(bin().find((f) => f.id === fb.id).proxy, "ready");
  assert.ok(existsSync(path.join(root, "work/montage-proxy", fb.id, "c0.mp4")));
  assert.deepEqual(bin().find((f) => f.id === fb.id).chunks, [true]); // 3 sn → tek parça
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width", "-of", "json", path.join(root, "work/montage-proxy", fb.id, "c0.mp4")], { encoding: "utf8" }));
  assert.equal(probe.streams.find((s) => s.codec_name === "h264").width, 640);
  assert.equal(await m.get(new URL(`http://x/api/montage/media?id=${fb.id}&chunk=0`), {}, fakeRes()), true);
  assert.equal(served.file, path.join(root, "work/montage-proxy", fb.id, "c0.mp4"));
  const au = bin().find((f) => f.kind === "audio");
  assert.equal(au.proxy, "none");
  await m.get(new URL(`http://x/api/montage/media?id=${au.id}`), {}, fakeRes());
  assert.equal(served.file, au.path);
  await m.get(new URL("http://x/api/montage/media?id=bilinmiyor"), {}, fakeRes());
  assert.equal(sent.code, 404);
  // proxy hazırken küçük resim proxy'den çıkar (önbellek dosyası -p ekli)
  await m.get(new URL(`http://x/api/montage/thumb?id=${fb.id}&t=1.5&w=160`), {}, fakeRes());
  assert.equal(sent.code, 200);
  assert.ok(existsSync(path.join(root, "work/montage-thumbs", `${fb.id}-15-160-p.jpg`)));
  // dalga formu
  await m.get(new URL(`http://x/api/montage/wave?id=${au.id}`), {}, fakeRes());
  assert.equal(sent.code, 200);
  const w = JSON.parse(sent.body);
  assert.equal(w.perSec, 20);
  assert.ok(Math.abs(w.peaks.length - 400) <= 2); // 20 sn × 20
  assert.equal(Math.max(...w.peaks), 100);
  assert.ok(existsSync(path.join(root, "work/montage-wave", `${au.id}.json`)));
});

test("Parçalı proxy: 130 sn'lik klip 3 parça (60+60+10); parçalar sırayla/paralel üretilir, her parça doğru uzunlukta; thumb doğru parçadan; eksik parça 404", { skip: !hasFfmpeg }, async () => {
  const long = path.join(root, "clips", "uzun.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=130", "-f", "lavfi", "-i", "sine=frequency=300:duration=130", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", "-shortest", long]);
  const [code, r] = await m.post["/api/montage/add"]({ path: long });
  assert.equal(code, 200);
  const st = () => m.post["/api/montage/state"]()[1].bin.find((f) => f.id === r.file.id);
  assert.equal(st().chunks.length, 3);
  let sawPartial = false;
  for (let i = 0; i < 240 && st().proxy !== "ready"; i++) { const c = st().chunks; if (c.some(Boolean) && !c.every(Boolean)) sawPartial = true; await new Promise((x) => setTimeout(x, 250)); }
  assert.equal(st().proxy, "ready");
  assert.deepEqual(st().chunks, [true, true, true]);
  const dur = (k) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(root, "work/montage-proxy", r.file.id, `c${k}.mp4`)], { encoding: "utf8" }).trim());
  assert.ok(Math.abs(dur(0) - 60) < 0.5 && Math.abs(dur(1) - 60) < 0.5 && Math.abs(dur(2) - 10) < 0.5, `parça süreleri ${dur(0)} ${dur(1)} ${dur(2)}`);
  // thumb 75. sn → parça 1'den (yerel 15 sn), -p önbellek adı
  await m.get(new URL(`http://x/api/montage/thumb?id=${r.file.id}&t=75&w=160`), {}, fakeRes());
  assert.equal(sent.code, 200);
  assert.ok(existsSync(path.join(root, "work/montage-thumbs", `${r.file.id}-750-160-p.jpg`)));
  // media: parça 1 var, parça 7 yok
  await m.get(new URL(`http://x/api/montage/media?id=${r.file.id}&chunk=1`), {}, fakeRes());
  assert.equal(served.file, path.join(root, "work/montage-proxy", r.file.id, "c1.mp4"));
  await m.get(new URL(`http://x/api/montage/media?id=${r.file.id}&chunk=7`), {}, fakeRes());
  assert.equal(sent.code, 404);
  console.log("  (kısmi hazır durum gözlendi: " + sawPartial + ")");
});

test("HLG proxy: görüntüleme LUT'u varsa lut3d'li zincir çalışır (Windows yolu/iki nokta dahil) ve 640 px H.264 proxy üretir", { skip: !hasFfmpeg || !hasX265 }, async () => {
  // 2×2×2 kimlik LUT: yalnız filtre zincirinin (yol kaçışı, gbrp16le, tetrahedral) çalıştığını doğrular
  const lutDir = path.join(root, "work/luts");
  mkdirSync(lutDir, { recursive: true });
  writeFileSync(path.join(lutDir, "hlg_to_sdr709_preview.cube"), "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  const f = path.join(root, "clips", "hlg-lut.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast",
    "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc", f]);
  const [code, r] = await m.post["/api/montage/add"]({ path: f });
  assert.equal(code, 200);
  assert.equal(r.file.kind, "hlg");
  const st = () => m.post["/api/montage/state"]()[1].bin.find((x) => x.id === r.file.id);
  for (let i = 0; i < 160 && st().proxy !== "ready" && st().proxy !== "failed"; i++) await new Promise((x) => setTimeout(x, 250));
  assert.equal(st().proxy, "ready", st().proxyError);
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,pix_fmt", "-of", "json", path.join(root, "work/montage-proxy", r.file.id, "c0.mp4")], { encoding: "utf8" })).streams[0];
  assert.deepEqual([out.codec_name, out.width, out.pix_fmt], ["h264", 640, "yuv420p"]);
});
