// Kurgu Atölyesi paneli: the workshop's files behind a local UI. No database: work/, out/, marka/ and
// src/theme/theme.ts stay the single source of truth, the same files Claude and the scripts use.
//   npm run studio          → http://localhost:3210 (only this machine)
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { p, PLAN, PROXY, ROOT, SOURCE } from "../scripts/lib/paths.mjs";
import * as youtube from "./youtube.mjs";
import { createMontage } from "./montage.mjs";
import { createPrivacy } from "./privacy.mjs";
import { pickClaudeExe, which, whichAll, whisperCli } from "../scripts/lib/platform.mjs";

const PORT = Number(process.env.STUDIO_PORT ?? 3210);
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const CHAT = p("work/studio-chat.json");
const CHOICES = p("work/video-secimleri.md");
const SELECTION = p("work/audio/selection.json");
const CORRECTIONS = p("work/transcript/corrections.tr.json");

const readJson = (f, fallback = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
const readText = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const mtime = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0);
const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; // signal 0 only asks, kills nothing
const trDate = (ms) => new Date(ms).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" });
// the job and the chat start child processes of their own; stop exactly that tree, by the PID we started
const killTree = (pid) => { if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); else { try { process.kill(-pid); } catch { process.kill(pid); } } };
const isWarning = (l) => /MODULE_TYPELESS|Reparsing as ES|To eliminate this|trace-warnings/.test(l);

// ── plan and its validation ────────────────────────────────────────────────────────────────
// The real validator decides. Rejected text never stays on disk, so a half-typed time cannot break a render.
const HISTORY = p("work/plan-history");
const historyFiles = () => (existsSync(HISTORY) ? readdirSync(HISTORY).filter((n) => n.endsWith(".json")).sort() : []);
const writePlanChecked = (plan) => {
  const before = readFileSync(PLAN, "utf8");
  writeFileSync(PLAN, `${JSON.stringify(plan, null, 2)}\n`);
  const r = spawnSync(process.execPath, [p("scripts/50-validate-plan.mjs")], { cwd: p(), encoding: "utf8", windowsHide: true });
  if (r.status === 0) {
    // every accepted panel edit can be taken back; the newest 50 are kept
    mkdirSync(HISTORY, { recursive: true });
    writeFileSync(path.join(HISTORY, `${String(Date.now())}.json`), before);
    for (const old of historyFiles().slice(0, -50)) rmSync(path.join(HISTORY, old));
    return null;
  }
  writeFileSync(PLAN, before);
  const lines = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim() && !isWarning(l));
  const errors = lines.filter((l) => /^HATA/.test(l));
  return (errors.length ? errors : lines).slice(0, 3).join(" · ") || "Plan geçersiz.";
};

// ── §9 choices: work/video-secimleri.md stays readable, selection.json and the plan get what the audio step reads ──
const CHOICE_KEYS = { profil: "Renk profili", tempo: "Tempo", sfx: "Ses efekti", muzik: "Müzik", hook: "Açılış (hook)", kapanis: "Kapanış kartı", abone: "Abone kartı" };
const CHOICE_OPTIONS = {
  profil: ["Normal", "D-Log M, LUT uygulandı", "D-Log M, LUT yok", "Karışık"], tempo: ["Sade", "Dengeli", "Yoğun"], sfx: ["Hiç", "Hafif", "Belirgin"],
  muzik: ["Dosya verdim", "Müzik yok"], hook: ["Yok", "Var"], kapanis: ["Yok", "Var"], abone: ["Yok", "Var"],
};
const lower = (s) => s.toLocaleLowerCase("tr");
const readChoices = () => {
  const text = readText(CHOICES), out = {};
  for (const [k, label] of Object.entries(CHOICE_KEYS)) {
    const v = lower(text.match(new RegExp(`^- ${label.replace(/[()]/g, "\\$&")}: (.*)$`, "m"))?.[1] ?? "");
    out[k] = CHOICE_OPTIONS[k].find((o) => v && (v.startsWith(lower(o)) || (k === "muzik" && v.startsWith("yok") && o === "Müzik yok") || (k === "muzik" && v.startsWith("dosya") && o === "Dosya verdim"))) ?? null;
  }
  return out;
};
const isApproved = () => /^Durum:.*plan onaylandı/im.test(readText(CHOICES));
const saveChoices = (choices) => {
  let text = readText(CHOICES) || "# Video seçimleri (MARKA.md §9)\nDurum: seçimler panelden girildi.\n";
  for (const [k, label] of Object.entries(CHOICE_KEYS)) {
    if (!CHOICE_OPTIONS[k].includes(choices[k])) continue;
    const line = `- ${label}: ${lower(choices[k]).replace(/^müzik yok$/, "yok").replace(/^dosya verdim$/, "dosya verdim")}`;
    const re = new RegExp(`^- ${label.replace(/[()]/g, "\\$&")}:.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(CHOICES, text);
  const selection = readJson(SELECTION);
  if (selection) {
    if (choices.muzik === "Müzik yok") selection.music = "none";
    if (choices.muzik === "Dosya verdim") selection.music = "(otomatik: public/assets içindeki ses dosyası)";
    if (choices.sfx === "Hafif") selection.levels.sfxDb = -13;
    if (choices.sfx === "Belirgin") selection.levels.sfxDb = -9;
    writeJson(SELECTION, selection);
  }
  const plan = readJson(PLAN);
  if (plan && choices.sfx) {
    for (const e of plan.events) { if (choices.sfx === "Hiç") e.sfx = false; else delete e.sfx; }
    return writePlanChecked(plan);
  }
  return null;
};
const setApproved = (approved) => {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); // local date, not UTC
  const status = approved ? `Durum: plan onaylandı (${today}).` : "Durum: plan onayı bekliyor.";
  const text = readText(CHOICES) || "# Video seçimleri (MARKA.md §9)\n";
  writeFileSync(CHOICES, /^Durum:.*$/m.test(text) ? text.replace(/^Durum:.*$/m, status) : `${text.trimEnd()}\n${status}\n`);
};

// Choices written by hand (the Claude workflow edits work/video-secimleri.md directly) must reach selection.json too,
// not only the ones saved through the panel: "Müzik yok" without music = "none" makes npm run audio fail otherwise.
const syncSelection = () => {
  const c = readChoices(), selection = readJson(SELECTION);
  if (!selection) return;
  if (c.muzik === "Müzik yok") selection.music = "none";
  if (c.sfx === "Hafif") selection.levels.sfxDb = -13;
  if (c.sfx === "Belirgin") selection.levels.sfxDb = -9;
  writeJson(SELECTION, selection);
};

// render time estimate: frames / measured speed of THIS machine (written by run-delivery-detached.mjs), 1.9 fps until the first measurement
// (810 frames of 4K in 415 s on 2026-10-31: graphics + composite + QC + audio); disk and RAM are shown before the start
const RATES = path.join(process.env.KURGU_DATA ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local/share"), "KurguAtolyesi"), "rates.json");
const renderEstimate = () => {
  const src = readJson(PLAN)?.source ?? {}, rate = readJson(RATES)?.framesPerSecond;
  return { seconds: Math.round((src.frames ?? 0) / (rate ?? 1.9)), measured: !!rate, diskFreeGB: Math.round(diskFreeBytes() / GB), diskNeededGB: Math.round(diskNeededBytes(src.durationSeconds ?? 0) / GB), ramFreeGB: +(os.freemem() / GB).toFixed(1) };
};

// ── progress, job ──────────────────────────────────────────────────────────────────────────
const STEP_INFO = [
  ["Proje açıldı", "05-new-project"], ["Kaynak okundu", "npm run probe"], ["LUT, proxy, varlıklar", "npm run proxy · assets"], ["Döküm", "npm run transcribe"],
  ["Varlık envanteri", "asset-manifest.json"], ["Kurgu planı", "npm run plan:check"], ["Tasarım kareleri", "66-cut-check --remotion"], ["Müzik", "selection.json"],
  ["Grafik render", "npm run render:gfx"], ["Birleştirme ve QC", "npm run composite · qc"], ["Ses ve miks QC", "npm run audio · qc:mix"], ["Görsel denetim", "qc-report.md"], ["Teslim", "out/README.tr.md"],
];
const readSteps = () => {
  const text = readText(p("work/progress.md"));
  const lines = [...text.matchAll(/^- \[([ x])\] (\d+) (.*)$/gm)];
  return STEP_INFO.map(([label, cmd], i) => {
    const m = lines.find((l) => Number(l[2]) === i);
    const done = m?.[1] === "x";
    return { label, cmd, state: !done ? "todo" : /atlandı|"yok" dedi/.test(m[3]) ? "skip" : "done" };
  });
};
const readJob = () => {
  const job = readJson(p("work/job.json"));
  if (!job) return { state: "idle", pct: 0, logs: [] };
  if (job.state === "running" && !alive(job.pid)) { job.state = "failed"; job.error = "İş yarıda kesildi (süreç kapanmış)."; }
  if (job.state === "stopped") job.error = "Render durduruldu. Önceki teslim varsa out/onceki-* içinde.";
  const logs = readText(p("work/logs/job.log")).split("\n").filter(Boolean);
  let pct = job.state === "done" ? 100 : 0;
  if (job.state === "running" && job.step === "master") {
    const compositeStarted = mtime(p("work/logs/composite.log")) >= job.startedAt;
    if (compositeStarted) {
      const frames = readJson(PLAN)?.source?.frames ?? 1;
      const last = [...readText(p("work/logs/composite.log")).matchAll(/frame=\s*(\d+)/g)].at(-1);
      pct = 30 + 60 * Math.min(1, Number(last?.[1] ?? 0) / frames);
    } else if (mtime(p("work/logs/render-gfx.log")) >= job.startedAt) {
      const gfx = readText(p("work/logs/render-gfx.log"));
      const todo = Number(gfx.match(/\d+ segment: (\d+) render/)?.[1] ?? 1);
      const segLines = gfx.split("\n").filter((l) => /^seg\d+\s+kare/.test(l));
      pct = todo ? 30 * Math.min(1, segLines.length / todo) : 30;
      if (segLines.length) logs.push(segLines.at(-1));
    }
  } else if (job.state === "running") pct = { qc: 90, audio: 95, qcmix: 97 }[job.step] ?? 0;
  const etaSeconds = job.state === "running" && pct >= 3 ? Math.round((((Date.now() - job.startedAt) / 1000) * (100 - pct)) / pct) : null;
  return { state: job.state, step: job.step, error: job.error, pct: Math.round(pct), etaSeconds, logs: logs.slice(-8) };
};
const renderState = (steps, job) => {
  if (job.state === "running") return "running";
  const final = p("out/final-hlg.mov");
  return steps.slice(8, 11).every((s) => s.state === "done") && existsSync(final) && mtime(PLAN) <= mtime(final) ? "done" : "idle";
};

// ── chat: a real Claude Code session in this folder, resumed by id for this project ───────────
let chatBusy = false;
let chatChild = null;
let chatStopped = false;
let chatActivity = "";
const describeTool = ({ name, input = {} }) => {
  if (name === "Bash" || name === "PowerShell") return input.description || String(input.command ?? "").split("\n")[0].slice(0, 80);
  if (name === "Skill") return `${input.skill ?? "beceri"} açılıyor`;
  const file = input.file_path ? path.basename(String(input.file_path)) : "";
  return { Read: `${file} okunuyor`, Edit: `${file} düzenleniyor`, Write: `${file} yazılıyor`, Grep: "Dosyalarda aranıyor", Glob: "Dosyalar listeleniyor" }[name] ?? name;
};
// every PATH hit is tried in order: a dangling npm shim must not hide the real claude.exe further down PATH (pickClaudeExe)
const claudeBin = () => pickClaudeExe(whichAll("claude"));
const CHAT_PREAMBLE = "Bu mesaj Kurgu Atölyesi panelinin sohbet kutusundan geliyor. CLAUDE.md'deki akışı izle, Türkçe ve kısa yanıtla. Cevabın dar bir yan panelde görünür: tablo ve başlık kullanma, kısa satırlar yaz. Render'ı panel başlatır; plan değişirse `npm run plan:check` çalıştır ve kullanıcıya panelden render'ı başlatmasını söyle.\n\nKullanıcı: ";
const readChat = () => readJson(CHAT, { sessionId: null, messages: [] });
const addMessage = (who, text) => {
  const chat = readChat();
  chat.messages.push({ who, text, time: new Date().toTimeString().slice(0, 5) });
  writeJson(CHAT, chat);
};
const askClaude = (text, context) => {
  const bin = claudeBin();
  if (!bin) { addMessage("c", "Claude Code bulunamadı: `claude` PATH'te yok."); return; }
  const chat0 = readChat();
  // the id is ours from the first message, so closing the app mid-run cannot lose the conversation
  const resume = !!chat0.sessionId;
  const sessionId = chat0.sessionId ?? randomUUID();
  if (!resume) writeJson(CHAT, { ...chat0, sessionId });
  chatBusy = true;
  chatActivity = "";
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep,Skill,Bash(npm run *),Bash(node scripts/*),Bash(ffmpeg *),Bash(ffprobe *),PowerShell(npm run *),PowerShell(node scripts/*),PowerShell(ffmpeg *),PowerShell(ffprobe *)", resume ? "--resume" : "--session-id", sessionId];
  const child = spawn(bin, args, { cwd: p(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  chatChild = child;
  chatStopped = false;
  let buffer = "", err = "", result = null;
  const onLine = (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "result") result = m;
    if (m.type === "assistant") for (const c of m.message?.content ?? []) if (c.type === "tool_use") chatActivity = describeTool(c);
  };
  child.stdout.on("data", (d) => { buffer += d; const lines = buffer.split("\n"); buffer = lines.pop(); lines.forEach(onLine); });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", (e) => { chatBusy = false; addMessage("c", `Claude başlatılamadı: ${e.message}`); });
  child.on("close", (code) => {
    onLine(buffer);
    chatBusy = false;
    chatChild = null;
    chatActivity = "";
    if (chatStopped) { addMessage("c", "Durduruldu."); return; }
    if (!result) {
      // a session that cannot be resumed must not block every later message
      const chat = readChat();
      writeJson(CHAT, { ...chat, sessionId: null, messages: [...chat.messages, { who: "c", text: `Claude yanıt vermedi (çıkış ${code}). ${err.trim().slice(0, 300)}\nSonraki mesaj yeni oturum açar.`, time: new Date().toTimeString().slice(0, 5) }] });
      return;
    }
    addMessage("c", result.result || "(boş yanıt)");
  });
  child.stdin.end(`${CHAT_PREAMBLE}${text}${context ? `\n\n(Panelde açık: ${context})` : ""}`);
};

// Started from a desktop shortcut the PATH can differ from a terminal's: say what is missing instead of failing later.
const MISSING_TOOLS = [["ffmpeg", which("ffmpeg")], ["ffprobe", which("ffprobe")], ["Claude Code", claudeBin()], ["whisper-cli", whisperCli()]].filter(([, found]) => !found).map(([name]) => name);
const GB = 2 ** 30;
const diskFreeBytes = () => { const s = statfsSync(p()); return s.bavail * s.bsize; };
// measured: 4K ProRes graphics ≈ 19 MB/s of video, master ≈ 6 MB/s; the render needs both at once
const diskNeededBytes = (seconds) => 2 * GB + seconds * 25 * 2 ** 20;

// Shorts from the finished master. Word timings come from one whisper pass with -ml 1; no music means a silent bed.
const shortJob = { state: "idle", error: null, last: "" };
const shortFiles = () => (existsSync(p("out/shorts")) ? readdirSync(p("out/shorts")).filter((n) => n.endsWith(".mp4")).map((name) => ({ name, size: statSync(p("out/shorts", name)).size })) : []);
const runLogged = (bin, args) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { cwd: p(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let err = "";
  child.stdout.on("data", (d) => { const l = String(d).trim().split("\n").at(-1); if (l) shortJob.last = l.slice(0, 160); });
  child.stderr.on("data", (d) => { err = (err + d).slice(-20000); });
  child.on("error", reject);
  child.on("close", (code) => { const lines = err.trim().split("\n").filter((l) => !isWarning(l)); code === 0 ? resolve() : reject(new Error(lines.find((l) => /error|hata|unknown/i.test(l)) ?? lines.at(-1) ?? `çıkış ${code}`)); });
});
const startShort = (b) => {
  const start = Number(b.start), end = Number(b.end), dur = +(end - start).toFixed(2);
  const total = readJson(p("work/source-metadata.json"))?.summary?.durationSeconds ?? 0;
  if (shortJob.state === "running") return [409, { error: "Short üretimi zaten sürüyor." }];
  if (jobRunning()) return [409, { error: "Render bitmeden short üretilemez." }];
  if (!existsSync(p("out/final-hlg.mov")) || !existsSync(p("out/final-hlg.temiz-ses.mov"))) return [409, { error: "Önce videoyu render et." }];
  if (!(start >= 0) || !(end <= total + 0.01) || !(dur >= 5) || dur > 180) return [422, { error: "Aralık 5–180 sn olmalı ve videonun içinde kalmalı." }];
  if (!String(b.title ?? "").trim()) return [422, { error: "Başlık boş olamaz." }];
  const report = readJson(p("work/audio/build/audio-report.json"));
  if (!report?.narration?.lufs) return [409, { error: "Ses ölçümü yok; önce render et." }];
  Object.assign(shortJob, { state: "running", error: null, last: "Hazırlanıyor" });
  (async () => {
    const dir = p("work/shorts");
    mkdirSync(dir, { recursive: true });
    const words = path.join(dir, "words");
    if (!existsSync(`${words}.json`)) {
      shortJob.last = "Kelime zamanları çıkarılıyor";
      const model = process.env.WHISPER_MODEL ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "Models/whisper/ggml-large-v3-turbo.bin");
      const wav = p("work/audio/main.16k.mono.wav"); // 20-transcribe skips it when a raw transcript already exists
      if (!existsSync(wav)) {
        mkdirSync(path.dirname(wav), { recursive: true });
        await runFfmpeg(["-v", "error", "-n", "-i", SOURCE, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
      }
      await runLogged(whisperCli() || "whisper-cli", ["-m", model, "-l", "tr", "-f", wav, "-ml", "1", "-sow", "-oj", "-of", words]);
    }
    const musicFile = report.createdFrom?.selection?.music;
    const hasMusic = musicFile && musicFile !== "none" && existsSync(p(musicFile));
    if (!hasMusic) await runFfmpeg(["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "2", path.join(dir, "sessiz.wav")]);
    const name = `short-${Math.round(start)}-${Math.round(end)}`;
    writeJson(path.join(dir, `${name}.json`), {
      name, fps: 30, layout: b.layout === "letterbox" ? "letterbox" : "portrait", video: { file: "out/final-hlg.mov", hlg: readJson(p("work/source-metadata.json"))?.summary?.hdr?.isHlgTagged ?? false }, narration: "out/final-hlg.temiz-ses.mov",
      music: hasMusic ? musicFile : "work/shorts/sessiz.wav", musicLufs: hasMusic ? report.musicSource.lufs : -70, words: "work/shorts/words.json", narrationLufs: report.narration.lufs,
      segments: [{ a: start, dur }], overlay: { kicker: String(b.kicker ?? ""), title: String(b.title).trim(), titleAccent: "", cta: { at: Math.max(1, dur - 2.5), text: String(b.cta ?? "Tam video kanalda"), sub: "@fatihkunak" }, locale: "tr" },
    });
    shortJob.last = "Short render ediliyor";
    await runLogged(process.execPath, [p("scripts/90-shorts.mjs"), `work/shorts/${name}.json`]);
    Object.assign(shortJob, { state: "done", last: `out/shorts/${name}.mp4` });
  })().catch((e) => Object.assign(shortJob, { state: "failed", error: e.message }));
  return [200, { ok: true }];
};

// ── state for the UI ───────────────────────────────────────────────────────────────────────
const OUT_FILES = [
  ["final-hlg.mov", "Yüklenecek video"], ["final-hlg.temiz-ses.mov", "Efekt öncesi master, kaynağın sesi"], ["final.tr.srt", "Altyazı (gömülü değil)"],
  ["stems", "Ses kanalları ayrı ayrı"], ["README.tr.md", "Teslim notu"],
];
const listProjects = (active, stepsDone, job, approved) => {
  const dir = p("projects");
  const archived = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const root = path.join(dir, d.name);
    const done = readText(path.join(root, "work/progress.md")).match(/\[x\]/g)?.length;
    return { slug: d.name, status: existsSync(path.join(root, "out/final-hlg.mov")) ? "Teslim edildi" : "Arşivlendi", step: done ? `${done}/13` : "—", date: trDate(mtime(root)), active: false };
  }) : [];
  if (!active) return archived;
  const final = existsSync(p("out/final-hlg.mov"));
  const status = job.state === "running" ? "Render çalışıyor" : stepsDone === 13 ? "Teslim edildi" : final ? "Teslime hazır" : approved ? "Render bekliyor" : "Plan onayı bekliyor";
  return [{ slug: active.slug, status, step: `${stepsDone}/13`, date: trDate(Date.parse(active.createdAt)), active: true }, ...archived];
};
const readBrand = () => {
  const marka = readText(p("marka/MARKA.md")), theme = readText(p("src/theme/theme.ts"));
  const tok = (name) => theme.match(new RegExp(`\\b${name}: (?:"([^"]+)"|([\\d.]+))`))?.slice(1).find(Boolean) ?? "";
  const m = marka.match(/>\s*\*\*"([^"]+)":\*\*[^\n]*\n\n([^\n]+)/);
  return {
    idea: m?.[1] ?? "", ideaText: m?.[2] ?? "",
    swatches: [["Zemin", "ink"], ["Yükseltilmiş", "inkRaised"], ["Çizgi", "line"], ["Metin", "text"], ["İkincil metin", "textMuted"], ["Vurgu", "accent"], ["Negatif", "negative"], ["Kanal kırmızısı", "brandRed"]].map(([name, note]) => ({ name, note, hex: tok(note) })),
    motion: [
      { k: "Giriş", v: `${tok("enter").replace(".", ",")} sn · kayarak ${tok("slide")} px` }, { k: "Çıkış", v: `${tok("exit").replace(".", ",")} sn` },
      { k: "Panel", v: `${tok("panelWidth")} px · üst ${tok("panelTop")} · kenar ${tok("margin")}` }, { k: "Zoom", v: (marka.match(/\*\*Zoom \/ punch-in:\*\* (.*)/)?.[1] ?? "").replace(/^ara sıra, yalnızca /, "yalnız ").replace(/atlama kesmelerini gizlemek için/, "atlama kesmesinde") },
    ],
    never: marka.match(/\*\*Asla:\*\* (.*)/)?.[1] ?? "",
  };
};
const buildState = () => {
  const project = readJson(p("work/project.json"));
  const meta = readJson(p("work/source-metadata.json"));
  const plan = readJson(PLAN);
  const v = meta?.summary?.video;
  const transcript = readJson(p("work/transcript.tr.json"));
  const steps = readSteps();
  const job = readJob();
  const approved = isApproved();
  const stepsDone = steps.filter((s) => s.state !== "todo").length;
  const selection = readJson(SELECTION);
  const listNames = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
  return {
    slug: project?.slug ?? null, createdAt: project?.createdAt ? trDate(Date.parse(project.createdAt)) : null,
    source: { duration: meta?.summary?.durationSeconds ?? plan?.source?.durationSeconds ?? 0, fps: plan?.source?.fps ?? null, frames: plan?.source?.frames ?? null, probed: !!meta, hdr: v?.colorTransfer === "arib-std-b67", hasProxy: existsSync(PROXY) },
    plan: plan ? { events: plan.events, notes: plan.notes ?? [], raw: plan } : { events: [], notes: [], raw: null }, planMtime: mtime(PLAN),
    audioStamp: `${mtime(SOURCE)}:${mtime(p("out/stems/efekt.wav"))}:${mtime(p("out/stems/muzik.wav"))}:${readJson(SELECTION)?.music}`,
    segments: transcript?.segments ?? [], uncertain: readJson(CORRECTIONS)?.uncertain ?? [],
    transcriptFiles: ["work/transcript.tr.srt", "work/transcript.tr.json", "work/transcript.tr.txt", "out/final.tr.srt"].filter((f) => existsSync(p(f))),
    steps, stepsDone, job, renderState: renderState(steps, job), approved, choices: readChoices(),
    audio: { sfxDb: selection?.levels?.sfxDb ?? null, music: selection?.music ?? null },
    out: OUT_FILES.map(([name, desc]) => ({ name, desc, ready: existsSync(p("out", name)), size: existsSync(p("out", name)) && statSync(p("out", name)).isFile() ? statSync(p("out", name)).size : null })),
    finalStill: listNames(p("work/qc/stills/final-hlg.candidate")).filter((n) => /_2tutus\.jpg$/.test(n)).at(-1) ?? null,
    assets: listNames(p("public/assets")).filter((n) => !n.endsWith(".partial")), stills: listNames(p("work/qc/design")).filter((n) => /\.jpe?g$/.test(n)),
    projects: listProjects(project, stepsDone, job, approved), brand: readBrand(),
    chat: { messages: readChat().messages, busy: chatBusy, activity: chatActivity },
    estimate: renderEstimate(), shorts: { job: shortJob, files: shortFiles(), suggestions: readJson(p("work/shorts-oneri.json")) }, youtube: { ...youtube.status(), meta: readJson(p("work/youtube.json")) },
    missingTools: MISSING_TOOLS, canUndo: historyFiles().length > 0,
  };
};

// ── http ───────────────────────────────────────────────────────────────────────────────────
const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = async (req) => {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error("Gövde çok büyük."); }
  return JSON.parse(raw || "{}");
};
const MEDIA_TYPES = { ".woff2": "font/woff2", ".mp4": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".aif": "audio/aiff", ".aiff": "audio/aiff" };
const openStreams = new Set();
let opening = false; // a new project is being opened: nothing may touch the files being moved
const serveFile = (req, res, file) => {
  if (!existsSync(file)) return send(res, 404, { error: "yok" });
  const { size } = statSync(file);
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  // a closed browser connection must close the file too: Windows cannot move a file that is still open
  const stream = (opts) => { const s = createReadStream(file, opts); openStreams.add(s); res.on("close", () => { s.destroy(); openStreams.delete(s); }); return s.pipe(res); };
  if (!range) { res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" }); return stream(); }
  const start = range[1] ? Number(range[1]) : size - Number(range[2]);
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start < 0) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  return stream({ start, end });
};

// timeline material, measured from the real video and cached next to the other QC output
const STUDIO_CACHE = p("work/qc/studio");
const pending = new Map();
const cached = (file, make) => {
  if (mtime(file) && mtime(file) >= mtime(PROXY)) return Promise.resolve();
  if (!pending.has(file)) pending.set(file, make().finally(() => pending.delete(file)));
  return pending.get(file);
};
const runFfmpeg = (args, opts = {}) => new Promise((resolve, reject) => execFile("ffmpeg", args, { encoding: "buffer", maxBuffer: 2 ** 30, windowsHide: true, ...opts }, (e, out) => (e ? reject(e) : resolve(out))));
const FILM_FRAMES = 14;
const filmFile = () => path.join(STUDIO_CACHE, "film.jpg");
const makeFilm = () => cached(filmFile(), async () => {
  mkdirSync(STUDIO_CACHE, { recursive: true });
  const duration = readJson(p("work/source-metadata.json"))?.summary?.durationSeconds || 1;
  await runFfmpeg(["-v", "error", "-y", "-i", PROXY, "-vf", `fps=${FILM_FRAMES}/${duration},scale=240:-2,tile=${FILM_FRAMES}x1`, "-frames:v", "1", "-q:v", "5", filmFile()]);
});
// Audio tracks are measured from the real files at their full sample rate, never normalised: 1.0 is 0 dBFS, so what
// the timeline shows is the level that is in the file. Each bucket keeps min, max and RMS across both channels.
// aresample async places samples by their timestamps: a gap in the audio stays a gap instead of shifting everything after it.
const measureAudio = (file, duration) => new Promise((resolve, reject) => {
  const rate = 48000, buckets = Math.min(6000, Math.max(800, Math.ceil(duration * 60)));
  const perBucket = Math.max(1, Math.floor((rate * duration) / buckets));
  const min = new Float64Array(buckets), max = new Float64Array(buckets), sum = new Float64Array(buckets), count = new Float64Array(buckets);
  const child = spawn("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0", "-ac", "2", "-ar", String(rate), "-c:a", "pcm_s16le", "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let index = 0, peak = 0, rest = null;
  child.stdout.on("data", (chunk) => {
    const data = rest ? Buffer.concat([rest, chunk]) : chunk;
    const whole = data.length - (data.length % 2);
    for (let o = 0; o < whole; o += 2, index++) {
      const v = data.readInt16LE(o) / 32768;
      const b = Math.min(buckets - 1, Math.floor(index / 2 / perBucket));
      if (v < min[b]) min[b] = v;
      if (v > max[b]) max[b] = v;
      sum[b] += v * v; count[b]++;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    rest = whole < data.length ? data.subarray(whole) : null;
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) { reject(new Error(`Ses okunamadı: ${path.basename(file)}`)); return; }
    const round = (a) => Array.from(a, (x) => +x.toFixed(4));
    resolve({ min: round(min), max: round(max), rms: round(sum.map((x, i) => (count[i] ? Math.sqrt(x / count[i]) : 0))), peakDb: peak ? +(20 * Math.log10(peak)).toFixed(2) : null, secondsPerBucket: perBucket / rate });
  });
});
const trackOf = (name, file, duration) => {
  const cache = path.join(STUDIO_CACHE, `track-${name}.json`);
  const stamp = `v2:${path.basename(file)}:${statSync(file).size}:${mtime(file)}:${duration}`;
  const hit = readJson(cache);
  if (hit?.stamp === stamp) return Promise.resolve(hit);
  const key = `track:${name}:${stamp}`;
  if (!pending.has(key)) pending.set(key, measureAudio(file, duration).then((m) => { mkdirSync(STUDIO_CACHE, { recursive: true }); const out = { ...m, stamp, file: path.relative(p(), file) }; writeJson(cache, out); return out; }).finally(() => pending.delete(key)));
  return pending.get(key);
};
const AUDIO_FILE = /\.(mp3|wav|m4a|aac|flac|aif|aiff|ogg)$/i;
const buildTracks = async () => {
  const duration = readJson(p("work/source-metadata.json"))?.summary?.durationSeconds ?? readJson(PLAN)?.source?.durationSeconds;
  if (!duration || !existsSync(SOURCE)) return { speech: null, sfx: null, music: null, sfxStale: false };
  const stem = (n) => p("out/stems", `${n}.wav`);
  const planTime = mtime(PLAN);
  const selection = readJson(SELECTION);
  const assetAudio = existsSync(p("public/assets")) ? readdirSync(p("public/assets")).find((n) => AUDIO_FILE.test(n)) : null;
  const silent = (t) => (t.peakDb === null ? null : t);
  return {
    speech: await trackOf("konusma", SOURCE, duration),
    sfx: existsSync(stem("efekt")) ? silent(await trackOf("efekt", stem("efekt"), duration)) : null,
    sfxStale: existsSync(stem("efekt")) && mtime(stem("efekt")) < planTime,
    music: selection?.music === "none" ? null
      : existsSync(stem("muzik")) ? silent(await trackOf("muzik", stem("muzik"), duration))
      : assetAudio ? await trackOf("muzik", p("public/assets", assetAudio), duration) : null,
  };
};

const SLUG_TR = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
const slugFrom = (file) => {
  const base = path.parse(file).name.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, (c) => SLUG_TR[c]).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "video";
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  let slug = `${base}-${stamp}`.replace(/^-/, "");
  for (let n = 2; existsSync(p("projects", slug)); n++) slug = `${base}-${stamp}-${n}`;
  return slug;
};
const runNode = (script, args) => new Promise((resolve) => {
  execFile(process.execPath, [p(script), ...args], { cwd: p(), encoding: "utf8", windowsHide: true, maxBuffer: 2 ** 24 }, (e, stdout, stderr) => resolve({ ok: !e, stdout, stderr }));
});

const bundle = await esbuild.build({ entryPoints: [p("studio/app.jsx")], bundle: true, write: false, jsx: "automatic", format: "iife", target: "es2022", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
const APP_JS = bundle.outputFiles[0].text;
const jobRunning = () => readJob().state === "running";
const montage = createMontage({ p, ROOT, readJson, send, jobRunning, serveFile });
const privacy = createPrivacy({ p, ROOT, readJson, send, jobRunning, SOURCE });

const routes = {
  "/api/plan/event": (b) => {
    if (jobRunning()) return [409, { error: "Render çalışırken plan değiştirilemez." }];
    const plan = readJson(PLAN);
    const e = plan?.events.find((x) => x.id === b.id);
    if (!e) return [404, { error: "Olay bulunamadı." }];
    for (const k of ["start", "end", "side", "position", "reason"]) if (b[k] !== undefined) e[k] = b[k];
    for (const k of ["kicker", "headline", "sub"]) if (b.content?.[k] !== undefined) e.content[k] = b.content[k];
    if (b.fullContent) e.content = b.fullContent;
    if (e.type === "callout" && !e.content.sub) { delete e.content.sub; delete e.content.subAt; }
    const error = writePlanChecked(plan);
    return error ? [422, { error }] : [200, { ok: true }];
  },
  "/api/plan/undo": () => {
    if (jobRunning()) return [409, { error: "Render çalışırken plan değiştirilemez." }];
    const last = historyFiles().at(-1);
    if (!last) return [409, { error: "Geri alınacak değişiklik yok." }];
    copyFileSync(path.join(HISTORY, last), PLAN);
    rmSync(path.join(HISTORY, last));
    return [200, { ok: true }];
  },
  "/api/approve": (b) => { setApproved(!!b.approved); return [200, { ok: true }]; },
  "/api/choices": (b) => {
    if (jobRunning()) return [409, { error: "Render çalışırken seçimler değiştirilemez." }];
    const error = saveChoices(b.choices ?? {});
    return error ? [422, { error }] : [200, { ok: true }];
  },
  "/api/correct": (b) => {
    const to = String(b.to ?? "").trim();
    const data = readJson(CORRECTIONS);
    const u = data?.uncertain.find((x) => x.text === b.text);
    if (!u || !to) return [422, { error: "Düzeltme metni boş ya da pasaj bulunamadı." }];
    const before = readFileSync(CORRECTIONS, "utf8");
    data.corrections.push({ from: u.text, to });
    data.uncertain = data.uncertain.filter((x) => x !== u);
    writeJson(CORRECTIONS, data);
    const r = spawnSync(process.execPath, [p("scripts/21-review-transcript.mjs")], { cwd: p(), encoding: "utf8", windowsHide: true });
    if (r.status === 0) return [200, { ok: true }];
    writeFileSync(CORRECTIONS, before);
    return [422, { error: r.stderr.trim().split("\n")[0] || "Düzeltme uygulanamadı." }];
  },
  "/api/project/new": async (b) => {
    const video = String(b.video ?? "").trim().replace(/^["']|["']$/g, "");
    if (jobRunning() || chatBusy) return [409, { error: "Önce çalışan iş bitsin." }];
    if (!video || !existsSync(video) || !statSync(video).isFile()) return [422, { error: `Video bulunamadı: ${video || "yol boş"}` }];
    if (!/\.(mov|mp4|m4v|mkv)$/i.test(video)) return [422, { error: "Video dosyası bekleniyor (.mov, .mp4)." }];
    opening = true;
    await Promise.allSettled(pending.values());
    for (const s of openStreams) s.destroy();
    const r = await runNode("scripts/05-new-project.mjs", ["--slug", slugFrom(video), "--video", video]).finally(() => { opening = false; });
    if (!r.ok) return [409, { error: /TAMAMLANDI/.test(r.stderr) ? "Mevcut proje bitmemiş. Önce bitir ya da sohbetten arşivletmesini iste." : r.stderr.trim().split("\n").find((l) => /Error/.test(l)) ?? "Proje açılamadı." }];
    return [200, { ok: true }];
  },
  "/api/reveal": (b) => {
    if (b.project) {
      const dir = p("projects", path.basename(String(b.project)));
      if (!existsSync(dir)) return [404, { error: "Arşiv bulunamadı." }];
      if (process.platform === "win32") execFile("explorer.exe", [dir], () => {}); else execFile("open", [dir], () => {});
      return [200, { ok: true }];
    }
    const known = OUT_FILES.some(([name]) => name === b.name) || /^shorts\/[\w.-]+\.mp4$/.test(b.name ?? "");
    if (b.name !== "" && !known) return [422, { error: "Bilinmeyen dosya." }];
    const target = path.normalize(p("out", b.name ?? ""));
    if (!existsSync(target)) return [404, { error: "Dosya yok." }];
    if (process.platform === "win32") execFile("explorer.exe", b.name ? [`/select,${target}`] : [target], () => {}); // explorer exits 1 even on success
    else execFile("open", b.name ? ["-R", target] : [target], () => {});
    return [200, { ok: true }];
  },
  "/api/render/stop": () => {
    const job = readJson(p("work/job.json"));
    if (!job || job.state !== "running" || !alive(job.pid)) return [409, { error: "Çalışan render yok." }];
    killTree(job.pid);
    writeJson(p("work/job.json"), { ...job, state: "stopped", finishedAt: Date.now() });
    return [200, { ok: true }];
  },
  "/api/chat/stop": () => {
    if (!chatChild) return [409, { error: "Claude çalışmıyor." }];
    chatStopped = true;
    killTree(chatChild.pid);
    return [200, { ok: true }];
  },
  "/api/transcript/segment": (b) => {
    const to = String(b.text ?? "").replace(/\s+/g, " ").trim();
    const transcript = readJson(p("work/transcript.tr.json"));
    const seg = transcript?.segments.find((s) => s.start === b.start);
    if (!seg || !to) return [422, { error: "Metin boş ya da parça bulunamadı." }];
    if (seg.text === to) return [200, { ok: true }];
    const joined = transcript.segments.map((s) => s.text).join(" ");
    if (joined.split(seg.text).length > 2) return [422, { error: "Bu metin dökümde birden çok kez geçiyor; sohbetten düzelttir." }];
    const before = readFileSync(CORRECTIONS, "utf8");
    const data = JSON.parse(before);
    data.corrections.push({ from: seg.text, to });
    writeJson(CORRECTIONS, data);
    const r = spawnSync(process.execPath, [p("scripts/21-review-transcript.mjs")], { cwd: p(), encoding: "utf8", windowsHide: true });
    if (r.status !== 0) { writeFileSync(CORRECTIONS, before); return [422, { error: r.stderr.trim().split("\n")[0] || "Düzeltme uygulanamadı." }]; }
    // a passage the user just rewrote is no longer in doubt
    const now = readJson(p("work/transcript.tr.json")).segments.map((s) => s.text).join(" ");
    const after = readJson(CORRECTIONS);
    const left = after.uncertain.filter((u) => now.includes(u.text));
    if (left.length !== after.uncertain.length) { after.uncertain = left; writeJson(CORRECTIONS, after); spawnSync(process.execPath, [p("scripts/21-review-transcript.mjs")], { cwd: p(), windowsHide: true }); }
    return [200, { ok: true }];
  },
  "/api/shorts": (b) => startShort(b),
  "/api/youtube/client": (b) => { youtube.saveClient(String(b.text ?? "")); return [200, { ok: true }]; },
  "/api/youtube/connect": () => {
    const url = youtube.authUrl(`http://127.0.0.1:${PORT}/oauth/youtube`);
    // Google refuses embedded web views: consent happens in the default browser
    if (process.env.STUDIO_NO_BROWSER) return [200, { ok: true, url }];
    if (process.platform === "win32") execFile("rundll32", ["url.dll,FileProtocolHandler", url], () => {}); else execFile("open", [url], () => {});
    return [200, { ok: true, url }];
  },
  "/api/youtube/meta": (b) => {
    const meta = { title: String(b.title ?? "").slice(0, 100), description: String(b.description ?? "").slice(0, 5000), tags: Array.isArray(b.tags) ? b.tags.map(String).slice(0, 30) : [] };
    writeJson(p("work/youtube.json"), meta);
    return [200, { ok: true }];
  },
  // YouTube chapter list from the plan's chapter tags: >= 3 chapters, the first at 0:00, each >= 10 s
  "/api/youtube/chapters": () => {
    const tags = (readJson(PLAN)?.events ?? []).filter((e) => e.type === "tag").sort((a, b) => a.start - b.start);
    const rows = tags.map((e, k) => [k === 0 ? 0 : e.start, e.content.label.charAt(0) + e.content.label.slice(1).toLocaleLowerCase("tr")]);
    if (rows.length < 3) return [422, { error: "YouTube bölüm listesi için planda en az 3 bölüm etiketi (tag) gerekir." }];
    if (rows.some((r, k) => k && r[0] - rows[k - 1][0] < 10)) return [422, { error: "YouTube bölümleri en az 10 sn olmalı." }];
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return [200, { text: rows.map(([s, label]) => `${fmt(s)} ${label}`).join("\n") }];
  },
  "/api/youtube/upload": async (b) => {
    if (jobRunning()) return [409, { error: "Render bitmeden yüklenemez." }];
    if (b.privacy === "public" && b.confirmPublic !== true) return [409, { error: "Herkese açık yükleme için onay gerekli." }];
    const meta = readJson(p("work/youtube.json")) ?? {};
    const shortName = b.short ? path.basename(String(b.short)) : null;
    const file = shortName ? p("out/shorts", shortName) : p("out/final-hlg.mov");
    // Shorts: YouTube treats vertical videos up to 3 min as Shorts; #Shorts in the title helps. A separate upload of the same metadata.
    const title = shortName ? `${String(meta.title ?? "").slice(0, 91).trim()} #Shorts` : meta.title;
    const thumbnail = !shortName && existsSync(p("out/kapak.jpg")) ? p("out/kapak.jpg") : undefined;
    const captions = !shortName && b.captions && existsSync(p("out/final.tr.srt")) ? p("out/final.tr.srt") : undefined;
    await youtube.startUpload({ file, title, description: meta.description, tags: meta.tags, privacy: b.privacy ?? "private", thumbnail, captions });
    return [200, { ok: true }];
  },
  // after a failed qc / audio / qc:mix only that step onward reruns; the finished render and the delivery archive stay
  "/api/resume": () => {
    const job = readJob();
    if (job.state !== "failed" || !["qc", "audio", "qcmix"].includes(job.step)) return [409, { error: "Devam edilecek bir adım yok." }];
    syncSelection();
    const r = spawnSync(process.execPath, [p("scripts/run-delivery-detached.mjs"), "--resume"], { cwd: p(), encoding: "utf8", windowsHide: true });
    return r.status === 0 ? [200, { ok: true }] : [409, { error: r.stderr.trim() || "Devam edilemedi." }];
  },
  "/api/render": () => {
    if (jobRunning()) return [409, { error: "Render zaten çalışıyor." }];
    if (!isApproved()) return [409, { error: "Önce planı onayla (MARKA.md §7)." }];
    syncSelection();
    const seconds = readJson(PLAN)?.source?.durationSeconds ?? 0;
    if (diskFreeBytes() < diskNeededBytes(seconds)) return [409, { error: `Disk yetmez: bu render için yaklaşık ${(diskNeededBytes(seconds) / GB).toFixed(0)} GB gerekir, ${(diskFreeBytes() / GB).toFixed(0)} GB boş.` }];
    execFileSync(process.execPath, [p("scripts/run-delivery-detached.mjs")], { cwd: p(), windowsHide: true });
    return [200, { ok: true }];
  },
  "/api/chat": (b) => {
    const text = String(b.text ?? "").trim();
    if (!text) return [422, { error: "Mesaj boş." }];
    if (chatBusy) return [409, { error: "Claude önceki mesajı bitirmedi." }];
    addMessage("u", text);
    askClaude(text, String(b.context ?? "").slice(0, 200));
    return [200, { ok: true }];
  },
};

Object.assign(routes, montage.post, privacy.post);

const server = http.createServer(async (req, res) => {
  try {
    // this server can run an agent: only pages it served itself may talk to it (no DNS rebinding, no cross-site POST)
    if (!HOSTS.has(req.headers.host)) { req.resume(); return send(res, 403, { error: "Yalnız yerel erişim." }); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (!origin || !HOSTS.has(origin.replace(/^https?:\/\//, ""))) { req.resume(); return send(res, 403, { error: "Yalnız panelden." }); }
      if (url.pathname === "/api/assets") {
        const name = path.basename(url.searchParams.get("name") ?? "");
        const target = p("public/assets", name);
        if (!name || name.startsWith(".")) return send(res, 422, { error: "Geçersiz dosya adı." });
        if (existsSync(target)) return send(res, 409, { error: `${name} zaten var; özgün dosyalar üzerine yazılmaz.` });
        const partial = `${target}.partial`;
        try { await pipeline(req, createWriteStream(partial)); renameSync(partial, target); } catch (e) { rmSync(partial, { force: true }); throw e; }
        return send(res, 200, { ok: true });
      }
      const route = routes[url.pathname];
      if (!route) return send(res, 404, { error: "yok" });
      const [code, body] = await route(await readBody(req));
      return send(res, code, body);
    }
    if (url.pathname === "/oauth/youtube") {
      const page = (t) => `<!doctype html><meta charset="utf-8"><title>Kurgu Atölyesi</title><body style="font:14px system-ui;background:#0B0A09;color:#ECEAE5;padding:40px">${t}`;
      try { await youtube.finishAuth(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? ""); return send(res, 200, page("YouTube hesabı bağlandı. Bu sekmeyi kapatabilirsin."), "text/html; charset=utf-8"); }
      catch (e) { return send(res, 400, page(String(e.message).replace(/[<&]/g, "")), "text/html; charset=utf-8"); }
    }
    if (url.pathname === "/") return send(res, 200, readFileSync(p("studio/index.html")), "text/html; charset=utf-8");
    if (url.pathname === "/studio-fonts.css") return send(res, 200, readFileSync(p("studio/fonts.css")), "text/css; charset=utf-8");
    if (url.pathname === "/app.js") return send(res, 200, APP_JS, "text/javascript; charset=utf-8");
    if (url.pathname === "/api/state") return send(res, 200, buildState());
    if (url.pathname.startsWith("/api/montage") && await montage.get(url, req, res)) return;
    if (url.pathname.startsWith("/api/privacy") && await privacy.get(url, req, res)) return;
    if (opening && (url.pathname.startsWith("/media/") || url.pathname === "/api/tracks")) return send(res, 503, { error: "Proje açılıyor." });
    if (url.pathname === "/api/audio") { // a few seconds of the narration around a passage: "listen to the uncertain part"
      const at = Math.max(0, Number(url.searchParams.get("at")) || 0), len = Math.min(8, Math.max(1, Number(url.searchParams.get("len")) || 5));
      if (!existsSync(SOURCE)) return send(res, 404, { error: "yok" });
      return send(res, 200, await runFfmpeg(["-v", "error", "-ss", String(Math.max(0, at - 1)), "-t", String(len), "-i", SOURCE, "-vn", "-ac", "1", "-ar", "22050", "-f", "wav", "pipe:1"]), "audio/wav");
    }
    if (url.pathname.startsWith("/media/short/")) return serveFile(req, res, p("out/shorts", path.basename(decodeURIComponent(url.pathname))));
    if (url.pathname === "/media/proxy") return serveFile(req, res, PROXY);
    if (url.pathname === "/media/film") { if (!existsSync(PROXY)) return send(res, 404, { error: "yok" }); await makeFilm(); return serveFile(req, res, filmFile()); }
    if (url.pathname === "/api/tracks") return send(res, 200, await buildTracks());
    if (url.pathname.startsWith("/media/final/")) return serveFile(req, res, p("work/qc/stills/final-hlg.candidate", path.basename(decodeURIComponent(url.pathname))));
    if (url.pathname.startsWith("/vendor/lucide/")) {
      const name = path.basename(url.pathname);
      if (!/^lucide\.(css|woff2|woff|ttf)$/.test(name)) return send(res, 404, { error: "yok" });
      const type = { ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" }[path.extname(name)];
      return send(res, 200, readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve("lucide-static/font/lucide.css")), name)), type);
    }
    if (url.pathname === "/media/avatar") return serveFile(req, res, p("public/marka/avatar.jpg"));
    if (url.pathname.startsWith("/media/still/")) return serveFile(req, res, p("work/qc/design", path.basename(decodeURIComponent(url.pathname))));
    // staticFile() of the real graphics layer: assets inside public/, nothing outside it
    const publicFile = path.resolve(p("public"), `.${decodeURIComponent(url.pathname)}`);
    if (publicFile.startsWith(p("public") + path.sep) && existsSync(publicFile) && statSync(publicFile).isFile()) return serveFile(req, res, publicFile);
    return send(res, 404, { error: "yok" });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.destroy();
  }
});
server.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? `Port ${PORT} dolu; STUDIO_PORT ile başka port verin.` : e.message); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => console.log(`Kurgu Atölyesi → http://localhost:${PORT}`));
