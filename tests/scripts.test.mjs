// Betiklerin saf mantığı için birim testleri (video, GPU ve ffmpeg gerekmez): restorasyon + döküm denetimleri.
//   npm run test:unit
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildChain, chunkFrames, estimateSeconds, fmtMin, frameCountMatches, frameSequence, loadRates, modelScale,
  parseRate, rateKey, saveRate, targetFps, targetSize, workKey,
} from "../scripts/92-restore.mjs";
import { checkPlace, cutArgs, musicStemFilter } from "../scripts/lib/music-placement.mjs";
import { pickClaudeExe } from "../scripts/lib/platform.mjs";
import { EMPTY_WHISPER, MIN_SPEECH_SECONDS, findGaps, findHallucinations, seg, speechSeconds } from "../scripts/lib/transcript-checks.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "kurgu-test-"));

// ---------- restore: boyut / fps / model ----------
test("Restore: kesirli kare hızı doğru okunur, bozuk değer 0 olur", () => {
  assert.ok(Math.abs(parseRate("30000/1001") - 29.97) < 0.01);
  assert.equal(parseRate("30/1"), 30);
  assert.equal(parseRate("0/0"), 0);
});

test("Restore: hedef fps — none/katı/mutlak değer; düşürme ve bozuk değer", () => {
  assert.equal(targetFps("none", 30), null);
  assert.equal(targetFps(undefined, 30), null);
  assert.equal(targetFps("2x", 30), 60);
  assert.equal(targetFps("60", 30), 60);
  assert.equal(targetFps("24", 30), null); // fps düşürmek restorasyon değil
  assert.throws(() => targetFps("abc", 30), /Geçersiz --fps/);
});

test("Restore: hedef boyut en-boy oranını korur, genişlik çifttir, küçültme yapılmaz", () => {
  assert.deepEqual(targetSize(1280, 720, 2160), { W: 3840, H: 2160, factor: 3 });
  const odd = targetSize(1000, 563, 2160);
  assert.equal(odd.W % 2, 0);
  assert.equal(odd.H, 2160);
  const same = targetSize(1920, 1080, 720); // hedef kaynaktan küçük: büyütme yok
  assert.equal(same.H, 1080);
  assert.ok(Math.abs(same.factor - 1) < 1e-9);
});

test("Restore: model adından ölçek çıkarılır", () => {
  assert.equal(modelScale("upscayl-lite-4x"), 4);
  assert.equal(modelScale("realesr-animevideov3-x2"), 2);
  assert.equal(modelScale("realesrgan-x4plus"), 4);
  assert.equal(modelScale("bilinmeyen-model"), 4); // varsayılan
});

test("Restore: parça büyüklüğü diske göre ayarlanır, 600'ü aşmaz, yer yoksa 0", () => {
  const GiB = 2 ** 30;
  assert.equal(chunkFrames(0.5 * GiB, 1e7), 0);
  assert.equal(chunkFrames(1000 * GiB, 1e6), 600);
  const mid = chunkFrames(10 * GiB, 30e6);
  assert.ok(mid > 0 && mid < 600);
});

test("Restore: klasik zincir — denoise kapalıyken filtre yok, taramalıda bwdif, fps'te minterpolate", () => {
  const size = { W: 3840, H: 2160, factor: 3 };
  assert.deepEqual(buildChain({ src: { interlaced: false }, size: { W: 1280, H: 720, factor: 1 }, denoise: "off", fps: null, engine: "classic" }), []);
  const chain = buildChain({ src: { interlaced: true }, size, denoise: "light", fps: 60, engine: "classic" });
  assert.ok(chain[0].startsWith("bwdif"));
  assert.ok(chain.some((f) => f.startsWith("hqdn3d")));
  assert.ok(chain.some((f) => f.startsWith("minterpolate=fps=60")));
  assert.ok(chain.some((f) => f.startsWith("scale=3840:2160")));
  const ai = buildChain({ src: { interlaced: false }, size, denoise: "off", fps: null, engine: "ai" });
  assert.deepEqual(ai, []); // AI motorunda ölçekleme ESRGAN'a bırakılır
});

// ---------- restore: ölçüm, devam, doğrulama ----------
test("Restore: süre tahmini yalnız ölçüm varsa verilir (uydurma yok)", () => {
  assert.equal(estimateSeconds(undefined, 486), null);
  assert.equal(estimateSeconds({ secPerFrame: 0 }, 486), null);
  assert.ok(Math.abs(estimateSeconds({ secPerFrame: 1.02 }, 486) - 495.72) < 0.01);
});

test("Restore: hız kaydı yazılıp okunur; yazılamayan yer işi bozmaz", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "alt", "restore-rates.json");
    assert.deepEqual(loadRates(file), {}); // dosya yok → boş
    const key = rateKey({ model: "upscayl-lite-4x", src: { w: 1280, h: 720 }, size: { W: 3840, H: 2160 }, interp: 1 });
    saveRate(key, 1.0234567, 486, file);
    const back = loadRates(file);
    assert.equal(back[key].secPerFrame, 1.0235);
    assert.equal(back[key].frames, 486);
    // yazılamayan yol: dosyanın "içine" klasör açmaya çalışmak
    const blocker = path.join(dir, "dosya");
    writeFileSync(blocker, "x");
    assert.doesNotThrow(() => saveRate(key, 1, 100, path.join(blocker, "x", "r.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Restore: iş klasörü anahtarı aynı ayarda sabit, ayar değişince farklı", () => {
  const base = { input: "a.mp4", mtime: 1, bytes: 2, model: "m", W: 3840, H: 2160, denoise: "off", outFps: 30, start: 0, dur: null };
  assert.equal(workKey(base), workKey({ ...base }));
  assert.notEqual(workKey(base), workKey({ ...base, model: "x4" }));
  assert.notEqual(workKey(base), workKey({ ...base, mtime: 2 })); // kaynak değiştiyse eski parçalar kullanılmaz
  assert.match(workKey(base), /^[0-9a-f]{10}$/);
});

test("Restore: kare sayısı doğrulaması ve süre biçimi", () => {
  assert.ok(frameCountMatches(486, 486));
  assert.ok(frameCountMatches(485, 486)); // 1 karelik tolerans
  assert.ok(!frameCountMatches(480, 486));
  assert.ok(!frameCountMatches(NaN, 486));
  assert.equal(fmtMin(45), "45 sn");
  assert.equal(fmtMin(300), "5.0 dk");
});

test("Restore: numaralı PNG dizisinin kalıbı (RIFE 8 hane, bizim 6 hane)", () => {
  const dir = tmp();
  try {
    assert.equal(frameSequence(dir), null);
    for (const n of ["00000001.png", "00000002.png", "00000003.png", "notlar.txt"]) writeFileSync(path.join(dir, n), "");
    const s = frameSequence(dir);
    assert.equal(s.count, 3);
    assert.equal(s.start, 1);
    assert.equal(s.pattern, path.join(dir, "%08d.png"));
    const d2 = path.join(dir, "alt"); mkdirSync(d2);
    writeFileSync(path.join(d2, "000007.png"), "");
    assert.equal(frameSequence(d2).start, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Claude Code ikilisini bulma ----------
test("Claude Code: yetim npm kabuğu atlanır, PATH'te daha aşağıdaki gerçek claude.exe seçilir", () => {
  const hits = ["C:\\u\\npm\\claude", "C:\\u\\npm\\claude.cmd", "C:\\u\\.local\\bin\\claude.exe"];
  const exists = (f) => f === "C:\\u\\.local\\bin\\claude.exe"; // npm paketi silinmiş, kabuk kalmış
  assert.equal(pickClaudeExe(hits, { exists, win: true }), "C:\\u\\.local\\bin\\claude.exe");
});

test("Claude Code: kabuk sağlamsa (paket kurulu) PATH sırası korunur", () => {
  const shimExe = path.win32.join("C:\\u\\npm", "node_modules/@anthropic-ai/claude-code/bin/claude.exe"); // Windows yolları: test her işletim sisteminde aynı çalışır
  const hits = ["C:\\u\\npm\\claude.cmd", "C:\\u\\.local\\bin\\claude.exe"];
  assert.equal(pickClaudeExe(hits, { exists: () => true, win: true }), shimExe);
});

test("Claude Code: hiçbiri çalıştırılamazsa boş döner; Windows dışında ilk sonuç", () => {
  assert.equal(pickClaudeExe(["C:\\u\\npm\\claude"], { exists: () => false, win: true }), "");
  assert.equal(pickClaudeExe([], { win: true }), "");
  assert.equal(pickClaudeExe(["C:\\u\\bin\\claude.exe"], { exists: () => false, win: true }), "");
  assert.equal(pickClaudeExe(["/usr/local/bin/claude", "/opt/claude"], { win: false }), "/usr/local/bin/claude");
});

// ---------- döküm denetimleri ----------
const S = (start, end, text) => ({ start, end, text });

test("Döküm: whisper JSON saniyeye çevrilir, boş metinler atılır", () => {
  const out = seg({ transcription: [{ offsets: { from: 1500, to: 3000 }, text: " Merhaba " }, { offsets: { from: 3000, to: 4000 }, text: "   " }] });
  assert.deepEqual(out, [{ start: 1.5, end: 3, text: "Merhaba" }]);
});

test("Halüsinasyon: VAD'da karşılığı olan gerçek konuşma işaretlenmez", () => {
  const raw = [S(0, 4, "Bugün sizlere sıcak bir gün anlatacağım")];
  const vad = [S(0, 4, "bugün sizlere sıcak bir gün anlatacağım")];
  assert.deepEqual(findHallucinations(raw, vad), []);
});

test("Halüsinasyon: VAD'da karşılığı olmayan, 3+ tekrar ve kredi kalıbı yakalanır", () => {
  const raw = [
    S(0, 3, "Bugün hava çok sıcak"),
    S(20, 22, "Hadi bakalım devam"), S(22, 24, "Hadi bakalım devam"), S(24, 26, "Hadi bakalım devam"),
    S(60, 62, "Altyazı M.K."),
  ];
  const vad = [S(0, 3, "bugün hava çok sıcak"), S(20, 26, "hadi bakalım devam")];
  const f = findHallucinations(raw, vad);
  const byIndex = Object.fromEntries(f.map((x) => [x.index, x.reasons.join("|")]));
  assert.equal(byIndex[0], undefined); // gerçek konuşma
  assert.match(byIndex[3], /3\. ardışık tekrar/);
  assert.match(byIndex[4], /karşılığı yok/);
  assert.match(byIndex[4], /bilinen halüsinasyon kalıbı/);
});

test("Boşluk raporu: baştaki, aradaki ve sondaki konuşmasız kesitler; çakışan segmentler", () => {
  const segs = [S(5, 8, "a"), S(7, 12, "b"), S(30, 32, "c")];
  assert.deepEqual(findGaps(segs, 40, 4), [{ from: 0, to: 5 }, { from: 12, to: 30 }, { from: 32, to: 40 }]);
  assert.deepEqual(findGaps(segs, 40, 20), []); // eşik üstü kesit yok
  assert.deepEqual(findGaps([S(0, 10, "x")], 10, 4), []);
  assert.deepEqual(findGaps([], 10, 4), [{ from: 0, to: 10 }]);
});

// ---------- konuşma ön kontrolü ----------
const whisperJson = (...ranges) => ({ transcription: ranges.map(([a, b, t]) => ({ offsets: { from: a * 1000, to: b * 1000 }, text: ` ${t} ` })) });

test("Konuşma süresi: metinli segmentler toplanır, boş metin sayılmaz", () => {
  assert.equal(speechSeconds(whisperJson([0, 2, "merhaba"], [5, 6.5, "dünya"], [8, 20, "  "])), 3.5);
});

test("Konuşmasız klip: boş whisper çıktısı eşiğin altında kalır ve seg() ile okunur", () => {
  assert.equal(speechSeconds(EMPTY_WHISPER), 0);
  assert.ok(speechSeconds(EMPTY_WHISPER) < MIN_SPEECH_SECONDS);
  assert.deepEqual(seg(EMPTY_WHISPER), []);
  assert.ok(speechSeconds(whisperJson([0, 4, "uzun cümle"])) >= MIN_SPEECH_SECONDS);
});

// ---------- müzik yerleşimi (Montaj → 75-audio) ----------
const MF = { SR: 44100, dur: 345.478467, TOTAL: 15235000, gainDb: -3.456, fadeIn: 1.5, fadeOut: 4 };

test("Müzik yerleşimi: place yoksa filtre, 75-audio'nun eski şablonuyla BİREBİR aynı", () => {
  const legacy = `[0:a]aresample=${MF.SR}:filter_size=64:cutoff=0.97,aformat=sample_fmts=flt:channel_layouts=stereo,atrim=0:${MF.dur},volume=${MF.gainDb.toFixed(2)}dB,afade=t=in:st=0:d=${MF.fadeIn},afade=t=out:st=${(MF.dur - MF.fadeOut).toFixed(3)}:d=${MF.fadeOut},apad=whole_len=${MF.TOTAL}[m]`;
  assert.equal(musicStemFilter({ ...MF, place: null, segLen: 0 }), legacy);
  assert.equal(musicStemFilter({ ...MF, place: undefined, segLen: 0 }), legacy);
});

test("Müzik yerleşimi: başlangıç gecikmesi, kesite göre fade, videodan taşan kesit kırpılır, gainDb eklenir", () => {
  const f = musicStemFilter({ ...MF, place: { start: 10, in: 5, out: 65, gainDb: 2 }, segLen: 60 });
  assert.match(f, /atrim=0:60\.000/);
  assert.match(f, /volume=-1\.46dB/); // -3.456 + 2
  assert.match(f, /afade=t=out:st=56\.000:d=4\.000/);
  assert.match(f, /adelay=10000:all=1/);
  assert.match(f, /apad=whole_len=15235000\[m\]$/);
  const spill = musicStemFilter({ ...MF, place: { start: 340, in: 0, out: 60 }, segLen: 60 });
  assert.match(spill, /atrim=0:5\.478/); // 345,478 − 340
  const tiny = musicStemFilter({ ...MF, place: { start: 0, in: 0, out: 2 }, segLen: 2 });
  assert.match(tiny, /afade=t=in:st=0:d=1\.000,afade=t=out:st=1\.000:d=1\.000/); // fade'ler kesiti aşmaz
});

test("Müzik yerleşimi: doğrulama ve kesit argümanları", () => {
  assert.equal(checkPlace(null, 100), null);
  assert.equal(checkPlace({ start: 0, in: 0, out: 5 }, 100), null);
  assert.match(checkPlace({ start: 0, in: 5, out: 5.05 }, 100), /en az 0,1/);
  assert.match(checkPlace({ start: 99.95, in: 0, out: 9 }, 100), /sonunda/);
  assert.match(checkPlace({ start: -1, in: 0, out: 9 }, 100), /sonlu/);
  assert.deepEqual(cutArgs("m.mp3", { start: 3, in: 5, out: 65 }), ["-ss", "5", "-t", "60", "-i", "m.mp3"]);
});
