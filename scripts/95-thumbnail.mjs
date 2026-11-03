// YouTube thumbnail from a frame of the video + a title in the speaker's own words → out/kapak.jpg (1280×720, JPEG < 2 MB).
//   node scripts/95-thumbnail.mjs --title "Konsolosluğa gideceğim" [--accent "gideceğim"] [--at 6.5]
// The frame comes from the SDR proxy (already tone-mapped, 1080p is plenty for 1280×720). The panel's YouTube upload
// sets out/kapak.jpg as the thumbnail when it exists. Never invent claims or numbers for the title (Ev kuralları).
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { p, PROXY } from "./lib/paths.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const title = arg("title");
if (!title?.trim()) { console.error('Kullanım: node scripts/95-thumbnail.mjs --title "Konuşmada geçen bir cümle" [--accent "kelime"] [--at saniye]'); process.exit(2); }
if (!existsSync(PROXY)) { console.error("SDR proxy yok: önce npm run proxy"); process.exit(2); }

const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", PROXY], { encoding: "utf8" }));
const at = Math.min(Math.max(0, Number(arg("at") ?? duration * 0.4)), duration - 0.1);
mkdirSync(p("public/derived"), { recursive: true });
mkdirSync(p("out"), { recursive: true });
const frame = "derived/kapak-frame.jpg";
execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", PROXY, "-frames:v", "1", "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720", "-q:v", "2", p("public", frame)]);

const serveUrl = await bundle({ entryPoint: p("src/index.ts"), webpackOverride: enableTailwind, publicDir: p("public") });
process.on("exit", () => { try { rmSync(serveUrl, { recursive: true, force: true }); } catch { /* already gone */ } });
const inputProps = { title: title.trim(), accent: arg("accent") ?? "", frame, locale: "tr" };
const composition = await selectComposition({ serveUrl, id: "Thumbnail", inputProps });
const output = p("out/kapak.jpg");
await renderStill({ composition, serveUrl, output, inputProps, imageFormat: "jpeg", jpegQuality: 90, overwrite: true, logLevel: "error", chromiumOptions: { gl: "angle" } });
const size = statSync(output).size;
console.log(`Yazıldı: ${path.relative(p(), output)} (${(size / 1024).toFixed(0)} KB, kare ${at.toFixed(1)}. sn)`);
if (size > 2 * 2 ** 20) console.warn("Uyarı: YouTube kapak sınırı 2 MB; dosya büyük.");
