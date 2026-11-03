// YouTube upload for the panel: OAuth for an installed app (PKCE, loopback redirect) and the resumable upload protocol.
// Credentials stay in %LOCALAPPDATA%\KurguAtolyesi, outside the workshop. Nothing is published without the user's click,
// and the default privacy is private. YT_AUTH_BASE / YT_TOKEN_URL / YT_API_BASE exist so tests can run against a local mock.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.KURGU_DATA ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local/share"), "KurguAtolyesi");
const CLIENT = path.join(DIR, "youtube-client.json");
const TOKEN = path.join(DIR, "youtube-token.json");
const AUTH_BASE = process.env.YT_AUTH_BASE ?? "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = process.env.YT_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const API_BASE = process.env.YT_API_BASE ?? "https://www.googleapis.com";
const SCOPE = ["https://www.googleapis.com/auth/youtube.upload", ...(process.env.YT_CAPTIONS ? ["https://www.googleapis.com/auth/youtube.force-ssl"] : [])].join(" "); // captions.insert needs force-ssl: opt-in, reconnect after setting YT_CAPTIONS=1
const CHUNK = 16 * 2 ** 20; // resumable chunks must be multiples of 256 KiB

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const client = () => { const c = readJson(CLIENT); return c?.installed ?? c?.web ?? null; };
let pendingAuth = null;
export const upload = { state: "idle", pct: 0, error: null, url: null, notes: [] };

export const status = () => ({ hasClient: !!client(), connected: !!readJson(TOKEN)?.refresh_token, upload, clientPath: CLIENT });

export const saveClient = (text) => {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Bu dosya JSON değil."); }
  const c = parsed.installed ?? parsed.web;
  if (!c?.client_id) throw new Error("Bu dosya Google OAuth istemci dosyası değil (client_id yok).");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CLIENT, JSON.stringify(parsed));
};

export const authUrl = (redirectUri) => {
  const c = client();
  if (!c) throw new Error("Önce Google OAuth istemci dosyasını ekle.");
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(16).toString("hex");
  pendingAuth = { verifier, state, redirectUri };
  const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  return `${AUTH_BASE}?${q}`;
};

const tokenRequest = async (params) => {
  const c = client();
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, ...(c.client_secret ? { client_secret: c.client_secret } : {}), ...params }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google yetkilendirme hatası: ${data.error_description ?? data.error ?? r.status}`);
  return data;
};

export const finishAuth = async (code, state) => {
  if (!pendingAuth || state !== pendingAuth.state) throw new Error("Yetkilendirme isteği eşleşmedi; panelden yeniden bağlan.");
  const { verifier, redirectUri } = pendingAuth;
  pendingAuth = null;
  const data = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(TOKEN, JSON.stringify({ refresh_token: data.refresh_token }));
};

const accessToken = async () => {
  const saved = readJson(TOKEN);
  if (!saved?.refresh_token) throw new Error("YouTube hesabı bağlı değil.");
  return (await tokenRequest({ grant_type: "refresh_token", refresh_token: saved.refresh_token })).access_token;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Long uploads over travel connections: each chunk is retried, and after a failure the server is asked how much it has.
const putChunks = async (session, file, size, token) => {
  const fd = openSync(file, "r");
  try {
    let offset = 0, failures = 0;
    while (offset < size) {
      const length = Math.min(CHUNK, size - offset);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      let r;
      try {
        r = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "video/*", "content-range": `bytes ${offset}-${offset + length - 1}/${size}` }, body: buffer });
      } catch (e) { r = { status: 0, statusText: e.message }; }
      if (r.status === 200 || r.status === 201) return r.json();
      if (r.status === 308) {
        const range = r.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : offset;
        failures = 0;
      } else if (r.status === 0 || r.status >= 500) {
        if (++failures > 8) throw new Error(`Yükleme kesildi: ${r.statusText || r.status}`);
        await wait(2 ** failures * 500);
        const probe = await fetch(session, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-range": `bytes */${size}` } }).catch(() => null);
        if (probe?.status === 200 || probe?.status === 201) return probe.json();
        const range = probe?.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : probe?.status === 308 ? 0 : offset;
      } else {
        const body = await r.text().catch(() => "");
        throw new Error(`YouTube yüklemeyi reddetti (${r.status}): ${body.slice(0, 200)}`);
      }
      upload.pct = Math.round((offset / size) * 100);
    }
    throw new Error("Yükleme bitti ama YouTube onay vermedi.");
  } finally { closeSync(fd); }
};

// thumbnail and Turkish captions go up after the video; a failure here is reported in `notes`, the upload itself stays done
const extras = async (id, token, { thumbnail, captions }) => {
  const notes = [];
  if (thumbnail && existsSync(thumbnail)) {
    const r = await fetch(`${API_BASE}/upload/youtube/v3/thumbnails/set?videoId=${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" }, body: readFileSync(thumbnail) });
    notes.push(r.ok ? "kapak yüklendi" : `kapak yüklenemedi (${r.status})`);
  }
  if (captions && existsSync(captions)) {
    const boundary = `kurgu${Date.now()}`, meta = JSON.stringify({ snippet: { videoId: id, language: "tr", name: "Türkçe", isDraft: false } });
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`), readFileSync(captions), Buffer.from(`\r\n--${boundary}--`)]);
    const r = await fetch(`${API_BASE}/upload/youtube/v3/captions?part=snippet&uploadType=multipart`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body });
    notes.push(r.ok ? "altyazı yüklendi" : r.status === 403 ? "altyazı için ek izin gerekir (YT_CAPTIONS=1 ile yeniden bağlan)" : `altyazı yüklenemedi (${r.status})`);
  }
  return notes;
};

export const startUpload = async ({ file, title, description, tags, privacy, thumbnail, captions }) => {
  if (upload.state === "running") throw new Error("Yükleme zaten sürüyor.");
  if (!existsSync(file)) throw new Error("Yüklenecek video yok; önce render et.");
  if (!title?.trim()) throw new Error("Başlık boş olamaz.");
  if (!["private", "unlisted", "public"].includes(privacy)) throw new Error("Geçersiz görünürlük.");
  Object.assign(upload, { state: "running", pct: 0, error: null, url: null, notes: [], privacy });
  (async () => {
    const token = await accessToken();
    const size = statSync(file).size;
    const init = await fetch(`${API_BASE}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/*" },
      body: JSON.stringify({ snippet: { title: title.trim().slice(0, 100), description: description ?? "", tags: tags ?? [], categoryId: "22", defaultLanguage: "tr" }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }),
    });
    if (!init.ok) throw new Error(`YouTube oturum açmadı (${init.status}): ${(await init.text()).slice(0, 200)}`);
    const video = await putChunks(init.headers.get("location"), file, size, token);
    Object.assign(upload, { state: "done", pct: 100, url: `https://youtu.be/${video.id}`, actualPrivacy: video.status?.privacyStatus ?? privacy });
    try { upload.notes = await extras(video.id, token, { thumbnail, captions }); } catch (e) { upload.notes = [`ek dosyalar yüklenemedi: ${e.message}`]; }
  })().catch((e) => Object.assign(upload, { state: "failed", error: e.message }));
};
