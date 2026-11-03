// Panel tests against a throwaway copy of the workshop (.test-work/), never the current project.
//   npm run test:studio                                     fast: API, browser, waveform accuracy, offline, YouTube mock
//   STUDIO_TEST_VIDEO=<kesilmis-klip.mp4> npm run test:studio   adds a real render with ETA and a real Short (about 8 min)
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const W = path.join(ROOT, ".test-work");
const DATA = path.join(W, "_data");
const PORT = 3219, MOCK = 3218, B = `http://localhost:${PORT}`;
const VIDEO = process.env.STUDIO_TEST_VIDEO;
const w = (...x) => path.join(W, ...x);
const json = (f) => JSON.parse(readFileSync(w(f), "utf8"));
const node = (script, ...args) => execFileSync(process.execPath, [w(script), ...args], { cwd: W, stdio: "pipe", encoding: "utf8" });
const post = (route, body, headers = { origin: B }) => fetch(B + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const state = async () => (await fetch(`${B}/api/state`)).json();
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

let server, browser, page, mock;
const pageErrors = [], uploads = { init: null, bytes: 0, failedOnce: false, extras: [], tokenCalls: 0 };

const startMock = () => new Promise((resolve) => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url.startsWith("/token")) {
        uploads.tokenCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ access_token: "t", refresh_token: "r" }));
      }
      if (req.url.startsWith("/upload/youtube/v3/thumbnails/set") || req.url.startsWith("/upload/youtube/v3/captions")) {
        uploads.extras.push({ url: req.url, bytes: body.length });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (req.method === "POST") {
        uploads.init = { query: req.url, meta: JSON.parse(body), length: Number(req.headers["x-upload-content-length"]) };
        res.writeHead(200, { location: `http://127.0.0.1:${MOCK}/session` });
        return res.end();
      }
      const range = req.headers["content-range"];
      if (range?.startsWith("bytes */")) {
        if (uploads.bytes) res.writeHead(308, { range: `bytes=0-${uploads.bytes - 1}` }); else res.writeHead(308);
        return res.end();
      }
      if (!uploads.failedOnce && body.length) { uploads.failedOnce = true; res.writeHead(503); return res.end(); } // a dropped chunk must be retried
      uploads.bytes += body.length;
      const total = Number(range.split("/")[1]);
      if (uploads.bytes >= total) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "MOCKID", status: { privacyStatus: uploads.init.meta.status.privacyStatus } })); }
      res.writeHead(308, { range: `bytes=0-${uploads.bytes - 1}` });
      res.end();
    });
  }).listen(MOCK, "127.0.0.1", resolve);
});

before(async () => {
  rmSync(W, { recursive: true, force: true });
  for (const d of ["public/assets", "public/fonts", "public/marka", "out", "work/transcript", "work/audio/build", "work/logs"]) mkdirSync(w(d), { recursive: true });
  for (const d of ["scripts", "src", "library", "marka", "public/fonts", "public/marka"]) cpSync(path.join(ROOT, d), w(d), { recursive: true });
  // tüm panel kaynağı (server.mjs montage.mjs/privacy.mjs/timeline/ ... içe aktarır); testler ve masaüstü (Tauri) hariç
  cpSync(path.join(ROOT, "studio"), w("studio"), { recursive: true, filter: (src) => !/[\\/]studio[\\/](tests|desktop)([\\/]|$)/.test(src) });
  for (const f of ["package.json", "tsconfig.json", "remotion.config.ts"]) cpSync(path.join(ROOT, f), w(f));
  writeFileSync(w("package.json"), readFileSync(path.join(ROOT, "package.json")));
  if (VIDEO) cpSync(VIDEO, w("public/main.mov"));
  else execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12", "-f", "lavfi", "-i", "sine=f=330:d=12", "-af", "volume=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", w("public/main.mov")]);
  writeFileSync(w("work/project.json"), JSON.stringify({ slug: "test", createdAt: new Date().toISOString() }));
  cpSync(w("library/audio/selection.default.json"), w("work/audio/selection.json"));
  node("scripts/00-probe.mjs");
  node("scripts/40-make-luts.mjs");
  node("scripts/10-proxy.mjs");
  const meta = json("work/source-metadata.json").summary;
  const fps = Number(meta.video.rFrameRate.split("/")[0]) / Number(meta.video.rFrameRate.split("/")[1]);
  const callout = (id, start, end, head) => ({ id, type: "callout", start, end, side: "right", position: "sağ üst panel", enter: "kayarak", exit: "sönerek", transcript: "deneme", reason: "test", content: { kicker: "DENEME", headline: head, sub: "Alt satır", subAt: start + 1 } });
  writeFileSync(w("work/edit-plan.json"), JSON.stringify({ version: 1, source: { path: "public/main.mov", fps, frames: meta.video.nbFrames, durationSeconds: meta.durationSeconds }, language: "tr", notes: ["not"], unusedAssets: [], quietSections: [], events: [callout("E01", 0.6, 4.6, "Birinci"), callout("E02", 6, 10, "İkinci")] }, null, 2));
  writeFileSync(w("work/video-secimleri.md"), "# Video seçimleri\nDurum: plan onaylandı (test).\n- Ses efekti: hafif\n- Müzik: yok\n");
  const sel = json("work/audio/selection.json"); sel.music = "none"; writeFileSync(w("work/audio/selection.json"), JSON.stringify(sel));
  const seg = (from, to, text) => ({ offsets: { from, to }, text });
  writeFileSync(w("work/transcript/raw.json"), JSON.stringify({ transcription: [seg(0, 4000, "Birinci parça burada."), seg(4000, 8000, "İkinci parça belirsiz yer."), seg(8000, 12000, "Son parça.")] }));
  writeFileSync(w("work/transcript/corrections.tr.json"), JSON.stringify({ corrections: [], uncertain: [{ at: 5, text: "belirsiz yer", note: "test" }] }));
  node("scripts/21-review-transcript.mjs");
  await startMock();
  server = spawn(process.execPath, ["studio/server.mjs"], { cwd: W, stdio: "ignore", windowsHide: true, env: { ...process.env, STUDIO_NO_BROWSER: "1", STUDIO_PORT: String(PORT), KURGU_DATA: DATA, YT_AUTH_BASE: `http://127.0.0.1:${MOCK}/auth`, YT_TOKEN_URL: `http://127.0.0.1:${MOCK}/token`, YT_API_BASE: `http://127.0.0.1:${MOCK}` } });
  for (let i = 0; i < 120; i++) { try { await fetch(`${B}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(B);
  await page.waitForSelector("canvas");
});

after(async () => {
  await browser?.close();
  mock?.closeAllConnections(); mock?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 800));
  rmSync(W, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

test("yabancı istekler reddedilir", async () => {
  assert.equal((await post("/api/approve", {}, {})).status, 403);
  assert.equal((await post("/api/approve", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${B}/..%2Fpackage.json`)).status, 404);
  assert.equal((await post("/api/reveal", { name: "..\\..\\package.json" })).status, 422);
});

test("dalga formu ffmpeg ölçümüyle aynı", async () => {
  const tr = await (await fetch(`${B}/api/tracks`)).json();
  const stats = (args) => /Peak level dB: (-?[\d.]+)/.exec(spawnSync("ffmpeg", ["-hide_banner", ...args, "-i", w("public/main.mov"), "-af", "aformat=channel_layouts=stereo,astats=measure_overall=Peak_level:measure_perchannel=none", "-f", "null", "-"], { encoding: "utf8" }).stderr)[1];
  assert.ok(Math.abs(tr.speech.peakDb - Number(stats([]))) < 0.1, `tepe ${tr.speech.peakDb}`);
  const sp = tr.speech.secondsPerBucket, a = Math.floor(3 / sp), b = Math.floor(4 / sp);
  let hi = 0; for (let i = a; i < b; i++) hi = Math.max(hi, tr.speech.max[i], -tr.speech.min[i]);
  assert.ok(Math.abs(db(hi) - Number(stats(["-ss", "3", "-t", "1"]))) < 0.5);
});

test("Başlık kaydedilir, geçersiz değer dosyaya yazılmaz, geri alınır", async () => {
  await page.getByLabel("Başlık", { exact: true }).fill("Değişti");
  await page.getByText("Kaydedildi", { exact: true }).waitFor({ timeout: 8000 });
  assert.equal(json("work/edit-plan.json").events[0].content.headline, "Değişti");
  const good = readFileSync(w("work/edit-plan.json"), "utf8");
  await page.getByLabel("Çıkış").fill("0.7");
  await page.getByText(/Kaydedilmedi/).waitFor({ timeout: 8000 });
  assert.equal(readFileSync(w("work/edit-plan.json"), "utf8"), good);
  await page.getByLabel("Çıkış").fill("4.6");
  await page.getByText("Kaydedildi", { exact: true }).waitFor({ timeout: 8000 });
  await page.locator("button.btn", { hasText: "Geri al" }).click();
  await page.getByText("Geri alındı", { exact: true }).waitFor({ timeout: 5000 });
  await post("/api/plan/undo");
  await page.waitForTimeout(5500);
  assert.equal(json("work/edit-plan.json").events[0].content.headline, "Birinci");
});

test("Grafik sürüklenince taşınır, kenardan uzar, iç zaman da kayar", async () => {
  const drag = async (name, fromX, dx) => {
    const box = await page.locator(`button[title="${name}"]`).boundingBox();
    const x = box.x + (fromX === "orta" ? box.width / 2 : box.width - 3), y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx / 2, y, { steps: 3 }); await page.mouse.move(x + dx, y, { steps: 3 }); await page.mouse.up();
    await page.getByText("Kaydedildi", { exact: true }).waitFor({ timeout: 8000 });
    await page.waitForTimeout(400);
  };
  const before = json("work/edit-plan.json").events[1];
  await drag("E02 · İkinci", "orta", -40);
  const moved = json("work/edit-plan.json").events[1];
  const delta = +(moved.start - before.start).toFixed(2);
  assert.ok(delta < 0, `taşınmadı: ${delta}`);
  assert.equal(+(moved.end - before.end).toFixed(2), delta);
  assert.equal(+(moved.content.subAt - before.content.subAt).toFixed(2), delta);
  await drag("E02 · İkinci", "kenar", 30);
  const trimmed = json("work/edit-plan.json").events[1];
  assert.equal(trimmed.start, moved.start);
  assert.ok(trimmed.end > moved.end);
});

test("Dökümde her parça düzenlenir, altyazıya işlenir", async () => {
  await page.locator("header").getByRole("button", { name: /Döküm$/ }).click();
  await page.getByRole("button", { name: "0:08 parçasını düzenle" }).click();
  await page.getByLabel("Parça metni").fill("Son parça düzeltildi.");
  await page.getByLabel("Parça metni").press("Enter");
  await page.getByLabel("Parça metni").waitFor({ state: "hidden", timeout: 8000 });
  assert.match(readFileSync(w("out/final.tr.srt"), "utf8"), /Son parça düzeltildi\./);
  // rewriting an uncertain passage clears the doubt
  await page.getByRole("button", { name: "0:04 parçasını düzenle" }).click();
  await page.getByLabel("Parça metni").fill("İkinci parça artık net.");
  await page.getByLabel("Parça metni").press("Enter");
  await page.getByLabel("Parça metni").waitFor({ state: "hidden", timeout: 8000 });
  assert.equal(json("work/transcript/corrections.tr.json").uncertain.length, 0);
});

test("Ağ kapalıyken arayüz ve grafik yazı tipleri yüklenir", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await ctx.newPage();
  const external = [];
  await ctx.route("**/*", (route) => { const u = new URL(route.request().url()); if (u.hostname === "localhost") return route.continue(); external.push(u.href); return route.abort(); });
  await p2.goto(B); await p2.waitForSelector("canvas"); await p2.waitForTimeout(1500);
  /* global document */
  const fonts = await p2.evaluate(() => Promise.all(["500 13px Geist", "400 12px 'Geist Mono'", "800 40px 'Barlow Condensed'", "600 20px Barlow", "700 15px 'IBM Plex Mono'"].map(async (f) => { const loaded = await document.fonts.load(f, "şğıİöçü").catch(() => []); return [f, loaded.length > 0 && document.fonts.check(f, "şğıİöçü")]; })));
  await ctx.close();
  assert.deepEqual(external, [], `dış istek: ${external}`);
  for (const [f, ok] of fonts) assert.ok(ok, f);
  assert.equal(readdirSync(w("src/theme")).includes("fonts.generated.ts"), true);
  assert.doesNotMatch(readFileSync(w("src/theme/theme.ts"), "utf8"), /google-fonts/);
});

test("YouTube: bağlanır, varsayılan özel yükler, kopan parçayı yeniden dener, public onaysız yüklenmez", async () => {
  writeFileSync(w("out/final-hlg.mov"), Buffer.alloc(40 * 2 ** 20, 7)); // chunks are 16 MiB
  assert.equal((await post("/api/youtube/connect")).status, 500); // no client yet
  assert.equal((await post("/api/youtube/client", { text: "{}" })).status, 500);
  assert.equal((await post("/api/youtube/client", { text: JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }) })).status, 200);
  const url = new URL((await (await post("/api/youtube/connect")).json()).url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /youtube\.upload$/);
  assert.equal((await fetch(`${B}/oauth/youtube?code=x&state=yanlis`)).status, 400);
  const url2 = new URL((await (await post("/api/youtube/connect")).json()).url);
  assert.equal((await fetch(`${B}/oauth/youtube?code=x&state=${url2.searchParams.get("state")}`)).status, 200);
  assert.equal((await state()).youtube.connected, true);
  await post("/api/youtube/meta", { title: "Başlık", description: "Açıklama", tags: ["a"] });
  assert.equal((await post("/api/youtube/upload", { privacy: "public" })).status, 409);
  assert.equal(uploads.init, null);
  writeFileSync(w("out/kapak.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9])); writeFileSync(w("out/final.tr.srt"), "1\n00:00:00,000 --> 00:00:01,000\nDeneme\n");
  assert.equal((await post("/api/youtube/upload", { captions: true })).status, 200);
  let s; for (let i = 0; i < 120; i++) { s = (await state()).youtube.upload; if (s.state !== "running") break; await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(s.state, "done", s.error);
  assert.equal(s.url, "https://youtu.be/MOCKID");
  assert.equal(uploads.init.meta.status.privacyStatus, "private");
  assert.equal(uploads.init.length, 40 * 2 ** 20);
  assert.equal(uploads.bytes, 40 * 2 ** 20);
  assert.equal(uploads.failedOnce, true);
  assert.deepEqual(s.notes, ["kapak yüklendi", "altyazı yüklendi"]); // kapak ve altyazı videodan sonra gider
  assert.equal(uploads.extras.length, 2);
  rmSync(w("out/final-hlg.mov"));
  assert.ok(!JSON.stringify(await state()).includes("\"s\""));
});

test("Render kilitleri: onaysız başlamaz, dev plan disk kontrolüne takılır", async () => {
  writeFileSync(w("work/video-secimleri.md"), "# Video seçimleri\nDurum: plan onayı bekliyor.\n- Ses efekti: hafif\n- Müzik: yok\n");
  const sel0 = json("work/audio/selection.json"); sel0.music = "(otomatik: public/assets içindeki ses dosyası)"; writeFileSync(w("work/audio/selection.json"), JSON.stringify(sel0));
  assert.equal((await post("/api/render")).status, 409);
  await post("/api/approve", { approved: true });
  const raw = readFileSync(w("work/edit-plan.json"), "utf8"), big = JSON.parse(raw);
  big.source.durationSeconds = 360000;
  writeFileSync(w("work/edit-plan.json"), JSON.stringify(big));
  const r = await post("/api/render");
  writeFileSync(w("work/edit-plan.json"), raw);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /Disk yetmez/);
  assert.ok(!existsSync(w("work/job.json")));
  // dosyaya elle yazılan "Müzik: yok" seçimi render başında selection.json'a işlenir (yoksa npm run audio düşer)
  assert.equal(json("work/audio/selection.json").music, "none");
  assert.equal((await post("/api/resume")).status, 409); // düşmüş iş yok, devam edilemez
});

test("Gerçek render kalan süre gösterir ve Short üretir", { skip: !VIDEO && "STUDIO_TEST_VIDEO yok", timeout: 25 * 60 * 1000 }, async () => {
  node("scripts/20-transcribe.mjs"); // the Short needs the 16 kHz file this writes
  node("scripts/21-review-transcript.mjs");
  assert.equal((await post("/api/render")).status, 200);
  const started = Date.now(), etas = [];
  let s;
  for (;;) {
    s = await state();
    if (s.job.etaSeconds != null) etas.push([Math.round((Date.now() - started) / 1000), s.job.etaSeconds, s.job.pct]);
    if (s.job.state !== "running" && Date.now() - started > 3000) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.equal(s.job.state, "done", s.job.error);
  const total = Math.round((Date.now() - started) / 1000);
  const mid = etas[Math.floor(etas.length / 2)];
  console.log(`render ${total} sn; ortadaki tahmin: ${mid[0]}. sn'de ${mid[1]} sn kaldı dedi, gerçek ${total - mid[0]} sn (%${mid[2]})`);
  assert.ok(etas.length > 3);
  assert.equal((await post("/api/shorts", { start: 1, end: 9, title: "Deneme short", cta: "Tam video kanalda" })).status, 200);
  for (let i = 0; i < 400; i++) { s = (await state()).shorts; if (s.job.state !== "running") break; await new Promise((r) => setTimeout(r, 3000)); }
  assert.equal(s.job.state, "done", s.job.error);
  const file = w("out/shorts", s.files[0].name);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" })).streams.find((x) => x.codec_type === "video");
  assert.equal(probe.width, 1080); assert.equal(probe.height, 1920);
  assert.ok(statSync(file).size > 1e5);
  const keep = process.env.STUDIO_TEST_KEEP;
  if (keep) cpSync(file, keep);
});

test("Short altyazısı döküm düzeltmesini ham kelime zamanlarıyla gösterir", async () => {
  const { correctedWords } = await import(pathToFileURL(path.join(ROOT, "scripts/lib/caption-words.mjs")).href);
  const raw = [["Bunlar", 3.46], ["acayip", 3.8], ["sıcak", 4.13], ["ya", 4.41]].map(([text, t]) => ({ t, text }));
  const out = correctedWords(raw, [{ start: 3, end: 5, text: "Burası acayip sıcak ya" }]);
  assert.deepEqual(out.map((x) => x.text), ["Burası", "acayip", "sıcak", "ya"]);
  assert.deepEqual(out.map((x) => x.t), [3.46, 3.8, 4.13, 4.41]);
  const more = correctedWords(raw, [{ start: 3, end: 5, text: "Burası çok acayip sıcak ya" }]);
  assert.equal(more.length, 5);
  assert.ok(more.every((x, i) => i === 0 || x.t >= more[i - 1].t));
});

test("Panel: ses parçası, bölüm listesi ve süre tahmini", async () => {
  const r = await fetch(`${B}/api/audio?at=1&len=2`);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), "RIFF"); // belirsiz pasajı dinle
  const ch = await post("/api/youtube/chapters");
  assert.ok([200, 422].includes(ch.status)); // planda 3 bölüm etiketi yoksa açıklama ile reddeder
  const st = await state();
  assert.ok(st.estimate.seconds >= 0 && st.estimate.diskFreeGB > 0 && st.estimate.ramFreeGB > 0);
});

test("Devam: düşen audio adımından kalan adımlar başlar, render zinciri yeniden başlamaz", async () => {
  writeFileSync(w("work/job.json"), JSON.stringify({ state: "failed", step: "audio", error: "deneme", startedAt: Date.now() - 1000 }));
  // job.log önceki testlerin (STUDIO_TEST_VIDEO ile gerçek render dahil) kayıtlarını taşır: yalnız BU devamın yazdığına bak
  const readLog = () => (existsSync(w("work/logs/job.log")) ? readFileSync(w("work/logs/job.log"), "utf8") : "");
  const logStart = readLog().length;
  assert.equal((await post("/api/resume")).status, 200);
  const jobLog = () => readLog().slice(logStart);
  // alt süreç ayrık çalışır: günlükte [devam] görünüp iş bitiş damgası alana kadar bekle (test klasörü silinirken yazan süreç kalmasın)
  let job;
  for (let k = 0; k < 240; k++) { job = json("work/job.json"); if (/\[devam\] audio/.test(jobLog()) && job.finishedAt) break; await new Promise((r) => setTimeout(r, 500)); }
  assert.match(jobLog(), /\[devam\] audio/); // düşen adımdan başladı
  assert.ok(!/master:detached/.test(jobLog()), "render zinciri yeniden başlamamalı");
  assert.ok(job.finishedAt, "iş bitmeli");
});

test("Sayfada JavaScript hatası yok", () => assert.deepEqual(pageErrors, []));
