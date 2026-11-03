// Composites the transparent graphics segments onto the ORIGINAL HLG base in one FFmpeg pass:
// the base is decoded once (10-bit, never converted), graphics are brought into HLG Y'CbCr by
// lib/filters.mjs, overlaid with straight alpha, and encoded once. Audio is stream-copied.
//   node scripts/70-composite.mjs                 → x265 master candidate (work/composite/final-hlg.candidate.mov)
//   node scripts/70-composite.mjs --draft         → fast VideoToolbox draft  (work/composite/draft-hlg.mov)
//   node scripts/70-composite.mjs --draft --until 20   → first 20 s only (diagnostics)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { p, SOURCE, SEGMENTS_DIR, sourceTiming } from "./lib/paths.mjs";
import { draftEncoder } from "./lib/platform.mjs";
import { gfxToHlg, stripDovi, OVERLAY, sourceIsHlg } from "./lib/filters.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const draft = process.argv.includes("--draft");
// --youtube: upload-safe variant (YouTube dropped frames in near-static, low-bitrate stretches of the
// open-GOP/B-frame master). Closed GOP, an IDR every second, no B-frames (→ no edit list), quality floor via CRF 12.
const youtube = process.argv.includes("--youtube");
const PRESET = "fast"; // was medium (~2 fps on the 6-core laptop, 4K); --preset medium restores the old master setting
const CRF = "14"; // chosen after the measured bake-off in work/color-pipeline.md §7
const until = arg("until");
const allowPartial = process.argv.includes("--allow-partial"); // diagnostics before all segments exist

const manifest = JSON.parse(readFileSync(`${SEGMENTS_DIR}/manifest.json`, "utf8"));
const { fpsNum, fpsDen, frames } = sourceTiming();
if (manifest.frames !== frames) throw new Error("Segment manifesti kaynakla uyuşmuyor; grafiklerin yeniden render edilmesi gerekir.");
let segs = manifest.segments.filter((s) => existsSync(p(s.file)));
if (segs.length !== manifest.segments.length && !allowPartial) throw new Error("Eksik segment var: önce `npm run render:gfx`.");
if (until) segs = segs.filter((s) => s.start / (fpsNum / fpsDen) < Number(until));

const fps = fpsDen === 1 ? String(fpsNum) : `${fpsNum}/${fpsDen}`;
// untagged SDR bases (e.g. dubbing tools) must be tagged BT.709 on the frames, else the container colr atom stays "unknown"
// optional per-video grade (work/project.json → "grade": ffmpeg filter chain applied to the base before the overlay)
const project = JSON.parse(readFileSync(p("work/project.json"), "utf8"));
const grade = project.grade;
// optional privacy blur (work/project.json → "privacy": true): face/plate mask video made by scripts/py/make-privacy-mask.py
// (white = blur). The base is pixelated at 1/32 resolution and merged through the feathered mask; 10-bit, no colour conversion.
const MASK = p("work/privacy/mask.mkv");
const privacy = project.privacy === true || process.argv.includes("--privacy");
if (privacy && !existsSync(MASK)) throw new Error("project.json privacy:true ama work/privacy/mask.mkv yok (scripts/py/make-privacy-mask.py).");
const { width: srcW, height: srcH } = JSON.parse(readFileSync(p("work/source-metadata.json"), "utf8")).summary.video;
const baseTag = sourceIsHlg() ? "" : ",setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
const lines = privacy
  ? [`[0:v]${stripDovi}${grade ? `,${grade}` : ""},format=yuv420p10le,split[pa][pb]`,
     `[pb]scale=${srcW / 32}:${srcH / 32}:flags=area,scale=${srcW}:${srcH}:flags=bicubic[pbl]`,
     `[MASKIN]scale=${srcW}:${srcH}:flags=bilinear,gblur=sigma=8,format=gray[pmk]`,
     `[pbl][pmk]alphamerge[pbla]`,
     `[pa][pbla]overlay=format=yuv420p10${baseTag}[b0]`]
  : [`[0:v]${stripDovi}${grade ? `,${grade}` : ""}${baseTag}[b0]`];
// Segments are always 3840×2160: a smaller source needs them scaled, or only their top-left part lands on the frame.
if (srcW * 9 !== srcH * 16) throw new Error(`Kaynak 16:9 değil (${srcW}x${srcH}); grafik katmanı yalnız 16:9 için tasarlandı.`);
const fitGfx = srcW === 3840 ? "" : `scale=${srcW}:${srcH}:flags=lanczos,`;
segs.forEach((s, i) => {
  lines.push(`[${i + 1}:v]${fitGfx}${gfxToHlg(s.start, fps)}[g${i + 1}]`);
  lines.push(`[b${i}][g${i + 1}]${OVERLAY}[b${i + 1}]`);
});
if (privacy) lines[2] = lines[2].replace("[MASKIN]", `[${segs.length + 1}:v]`);
mkdirSync(p("work/composite"), { recursive: true });
const graphFile = p("work/composite", draft ? "graph.draft.txt" : "graph.txt");
writeFileSync(graphFile, lines.join(";\n") + "\n");

// --out <name> writes a differently named file (encoder tests); a partial (--until) run can never be the candidate
const out = p("work/composite", arg("out") ?? (youtube ? "final-hlg.youtube.candidate.mov" : draft ? (until ? `draft-hlg.until${until}.mov` : "draft-hlg.mov") : until ? `test-x265.until${until}.mov` : "final-hlg.candidate.mov"));
const HLG = sourceIsHlg();
const hlgTags = HLG ? ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-color_range", "tv", "-chroma_sample_location", "left"]
  : ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-chroma_sample_location", "left"];
const vui = HLG ? "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc" : "colorprim=bt709:transfer=bt709:colormatrix=bt709";
const draftEnc = draftEncoder();
const encoder = draft
  ? draftEnc.args
  : ["-c:v", "libx265", "-preset", arg("preset") ?? PRESET, "-crf", arg("crf") ?? CRF, "-profile:v", "main10", "-pix_fmt", "yuv420p10le", "-dolbyvision", "0",
     "-x265-params", `${vui}:range=limited:chromaloc=0:repeat-headers=1:${youtube ? `keyint=${fpsNum / fpsDen}:min-keyint=${fpsNum / fpsDen}:open-gop=0:bframes=0:scenecut=0` : "keyint=120:min-keyint=60"}:log-level=warning`];

const args = [
  "-hide_banner", "-v", "warning", "-stats", "-y",
  "-i", SOURCE,
  ...segs.flatMap((s) => ["-threads", "2", "-i", p(s.file)]),
  ...(privacy ? ["-i", MASK] : []),
  "-/filter_complex", graphFile,
  "-map", `[b${segs.length}]`, "-map", "0:a:0",
  ...encoder, ...hlgTags, "-tag:v", "hvc1",
  "-fps_mode", "passthrough", "-video_track_timescale", String(fpsDen === 1 ? fpsNum * 10 : fpsNum),
  "-c:a", "copy", // original narration, untouched
  "-map_metadata", "-1", "-map_chapters", "-1",
  ...(until ? ["-t", until] : []),
  "-movflags", "+faststart+write_colr", "-f", "mov", out,
];
writeFileSync(p("work/composite", draft ? "command.draft.txt" : "command.txt"), `ffmpeg ${args.map((a) => (/[\s:;\[\]']/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
console.log(`${segs.length} segment → ${out}\n${draft ? `TASLAK (${draftEnc.label})` : `MASTER ADAYI (libx265 ${arg("preset") ?? PRESET} CRF ${arg("crf") ?? CRF})`}`);
const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
if (r.status !== 0) { console.error(`ffmpeg çıkış kodu ${r.status}`); process.exit(r.status ?? 1); }
console.log(`Yazıldı: ${out}`);
