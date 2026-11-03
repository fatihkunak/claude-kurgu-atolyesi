// Local Turkish transcription with whisper.cpp. The 16 kHz mono WAV is for recognition only and
// never replaces the master audio. One pass over the whole file => absolute source timestamps,
// no chunk boundaries to stitch. Raw output stays in work/transcript/raw.*; the reviewed
// transcript lives in work/transcript.tr.{txt,srt,json}.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SOURCE, p } from "./lib/paths.mjs";
import { whisperCli } from "./lib/platform.mjs";
import { EMPTY_WHISPER, MIN_SPEECH_SECONDS, speechSeconds } from "./lib/transcript-checks.mjs";

// language of the narration: --lang en (e.g. a dubbed English version); default Turkish
const LANG = (() => { const i = process.argv.indexOf("--lang"); return i > 0 ? process.argv[i + 1] : "tr"; })();
const MODEL = process.env.WHISPER_MODEL ?? path.join(os.homedir(), "Models/whisper/ggml-large-v3-turbo.bin");
const WAV = p("work/audio/main.16k.mono.wav");
const RAW = p("work/transcript/raw");
// Spelling hints only (product names, technical terms). Not a script of the speech.
// Per-video list: work/transcribe.vocab.txt — else the channel-wide default in library/.
const vocabFile = [p("work/transcribe.vocab.txt"), p("library/transcribe.vocab.tr.txt")].find((f) => existsSync(f));
const PROMPT = vocabFile ? readFileSync(vocabFile, "utf8").replace(/\s+/g, " ").trim() : "Claude, Claude Code, YouTube, video, kurgu";

if (existsSync(`${RAW}.json`) && !process.argv.includes("--force")) {
  console.log("Ham döküm zaten var, atlanıyor (yeniden üretmek için --force).");
  process.exit(0);
}
if (!existsSync(MODEL)) throw new Error(`Whisper modeli yok: ${MODEL}`);
mkdirSync(path.dirname(WAV), { recursive: true });
mkdirSync(path.dirname(RAW), { recursive: true });
// --force also re-extracts the WAV: after a re-assembled base the cached one is stale
if (process.argv.includes("--force") && existsSync(WAV)) rmSync(WAV);
if (!existsSync(WAV)) {
  execFileSync("ffmpeg", ["-v", "error", "-n", "-i", SOURCE, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", WAV], { stdio: "inherit" });
}
// Silero VAD pass, run FIRST: (a) tells whether the clip has any speech (a silent walk makes whisper invent
// "Altyazı M.K." lines), (b) doubles as the hallucination detector (scripts/22-check-hallucinations.mjs).
// Its timestamps are not trusted for cues: under VAD whisper.cpp stretches long segments over silence.
// Model: ggml-silero-v5.1.2.bin next to the whisper model (huggingface.co/ggml-org/whisper-vad). Skipped if absent.
const VAD_MODEL = process.env.WHISPER_VAD_MODEL ?? path.join(path.dirname(MODEL), "ggml-silero-v5.1.2.bin");
const VAD_RAW = p("work/transcript/vad/raw");
if (!process.argv.includes("--no-vad") && existsSync(VAD_MODEL)) {
  mkdirSync(path.dirname(VAD_RAW), { recursive: true });
  execFileSync(whisperCli() || "whisper-cli", [
    "-m", MODEL, "-f", WAV, "-l", LANG, "--prompt", PROMPT, "-bs", "5", "-bo", "5", "-ml", "84", "-sow",
    "--vad", "--vad-model", VAD_MODEL, "-otxt", "-ojf", "-of", VAD_RAW, "-pp",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`VAD geçişi: ${VAD_RAW}.{txt,json} → node scripts/22-check-hallucinations.mjs`);
  const speech = speechSeconds(JSON.parse(readFileSync(`${VAD_RAW}.json`, "utf8")));
  if (speech < MIN_SPEECH_SECONDS && !process.argv.includes("--force-speech")) {
    writeFileSync(`${RAW}.json`, JSON.stringify(EMPTY_WHISPER));
    writeFileSync(`${RAW}.txt`, "");
    writeFileSync(`${RAW}.srt`, "");
    console.log(`Konuşma yok (VAD: ${speech.toFixed(1)} sn < ${MIN_SPEECH_SECONDS} sn): ana whisper geçişi atlandı, boş döküm yazıldı. Yine de çalıştırmak için --force-speech.`);
    process.exit(0);
  }
} else if (!process.argv.includes("--no-vad")) {
  console.log(`VAD modeli yok (${VAD_MODEL}); konuşma ön kontrolü ve halüsinasyon denetimi atlandı.`);
}
execFileSync(whisperCli() || "whisper-cli", [
  "-m", MODEL, "-f", WAV, "-l", LANG, "--prompt", PROMPT,
  "-bs", "5", "-bo", "5", "-ml", "84", "-sow", // subtitle-sized segments split on word boundaries
  "-otxt", "-osrt", "-ojf", "-of", RAW, "-pp",
], { stdio: ["ignore", "inherit", "inherit"] });
console.log(`Ham döküm: ${RAW}.{txt,srt,json}`);

