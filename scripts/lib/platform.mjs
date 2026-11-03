// Platform helpers so the pipeline runs on Windows as well as macOS/Linux.
// Everything here is best-effort: probes must never throw.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";

// `which -a` / `where`: every hit on PATH in PATH order ([] when the tool is missing)
export function whichAll(cmd) {
  try {
    return execFileSync(IS_WIN ? "where" : "which", IS_WIN ? [cmd] : ["-a", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// `which` / `where`: first hit on PATH, or "" when the tool is missing
export function which(cmd) {
  return whichAll(cmd)[0] ?? "";
}

/**
 * The runnable Claude Code binary among PATH hits, in PATH order. On Windows a hit can be a native claude.exe, or an npm shim
 * (`claude` / `claude.cmd`) that only forwards to node_modules/@anthropic-ai/claude-code/bin/claude.exe and cannot be spawned
 * without a shell. A shim whose package is gone (npm uninstall leaves it behind) must be SKIPPED, not stop the search:
 * the real install is often further down PATH (e.g. ~/.local/bin/claude.exe). Returns "" when nothing runnable exists.
 */
export function pickClaudeExe(hits, { exists = existsSync, win = IS_WIN } = {}) {
  if (!win) return hits[0] ?? "";
  for (const h of hits) {
    if (/\.exe$/i.test(h)) { if (exists(h)) return h; continue; }
    const shimExe = path.win32.join(path.win32.dirname(h), "node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    if (exists(shimExe)) return shimExe;
  }
  return "";
}

// `ls -la` replacement: file names with sizes in MiB, or [] when the folder is missing
export function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
}

// `df -h` replacement (statfs works on Windows since Node 18.15)
export function diskFree(dir) {
  try {
    const s = statfsSync(dir);
    return `${((s.bavail * s.bsize) / 2 ** 30).toFixed(1)} GiB free of ${((s.blocks * s.bsize) / 2 ** 30).toFixed(1)} GiB`;
  } catch {
    return "";
  }
}

// Fast, inspection-only HEVC encoder for `composite --draft`. Masters always use libx265.
export function draftEncoder() {
  let encoders = "";
  try {
    encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
  } catch {}
  const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
  if (process.platform === "darwin" && has("hevc_videotoolbox")) {
    return { label: "VideoToolbox", args: ["-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-pix_fmt", "p010le", "-q:v", "65", "-g", "120"] };
  }
  if (has("hevc_nvenc")) {
    return { label: "NVENC", args: ["-c:v", "hevc_nvenc", "-preset", "p4", "-profile:v", "main10", "-pix_fmt", "p010le", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-g", "120"] };
  }
  return { label: "libx265 ultrafast", args: ["-c:v", "libx265", "-preset", "ultrafast", "-crf", "28", "-profile:v", "main10", "-pix_fmt", "yuv420p10le", "-dolbyvision", "0"] };
}

// Contact sheets without `-pattern_type glob` (Windows ffmpeg builds have no globbing):
// the matching frames go through the concat demuxer, one second each, then `tile`.
export function tileSheet(dir, re, tile, q) {
  const files = readdirSync(dir).filter((f) => re.test(f)).sort();
  if (!files.length) throw new Error(`Kontak sayfası için kare yok: ${dir}`);
  const list = path.join(dir, "_sheet-list.txt");
  writeFileSync(list, files.map((f) => `file '${f}'\nduration 1\n`).join(""));
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", tile, "-fps_mode", "passthrough", "-q:v", String(q), path.join(dir, "sheet_%02d.jpg")]);
  } finally {
    rmSync(list, { force: true });
  }
}

// whisper.cpp CLI: $WHISPER_CLI, then PATH, then the Windows build unpacked under ~/_tools (no PATH edit needed)
export function whisperCli() {
  if (process.env.WHISPER_CLI) return process.env.WHISPER_CLI;
  const onPath = which("whisper-cli");
  if (onPath) return onPath;
  const bundled = path.join(os.homedir(), "_tools", "whisper-cpp-1.9.2", "bin", "Release", "whisper-cli.exe");
  return existsSync(bundled) ? bundled : "";
}

// AAC encoder: Apple AudioToolbox (aac_at) on macOS, FFmpeg's native `aac` everywhere else.
export function aacEncoder() {
  if (process.platform !== "darwin") return "aac";
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
    return /\saac_at\s/.test(out) ? "aac_at" : "aac";
  } catch {
    return "aac";
  }
}
