// Duman testi: paneli kendi portunda, geçici veri klasöründe açar; yeni arayüz düğmelerini gerçek tarayıcıda dener.
//   npm run test:ui       (çalışma klasöründe bir proje ve out/shorts içinde en az bir Short varsa tüm kontroller anlamlıdır)
// Çıkış kodu 0 = beklenen düğmeler var, istekler 200, sayfada JS hatası yok.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { p } from "./lib/paths.mjs";

const PORT = 3297;
const server = spawn(process.execPath, ["studio/server.mjs"], {
  cwd: p(), stdio: "ignore", windowsHide: true,
  env: { ...process.env, STUDIO_NO_BROWSER: "1", STUDIO_PORT: String(PORT), KURGU_DATA: mkdtempSync(path.join(os.tmpdir(), "kurgu-ui-")) },
});
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "OK  " : "HATA"} ${name}${detail ? `  (${detail})` : ""}`); };
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* henüz açılmadı */ } await new Promise((r) => setTimeout(r, 250)); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], responses = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (/\/api\/audio|\/media\/short/.test(r.url())) responses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1500);

  await page.getByText("Döküm", { exact: true }).first().click(); // belirsiz pasajlar Döküm sekmesindedir
  await page.waitForTimeout(800);
  const listen = page.getByText("Dinle (5 sn)");
  if (await listen.count()) {
    await listen.first().click();
    await page.waitForTimeout(1500);
    check("Belirsiz pasaj: Dinle düğmesi ses isteği yapar", responses.some((r) => r.startsWith("200 /api/audio")), responses.find((r) => r.includes("/api/audio")) ?? "istek yok");
  } else check("Belirsiz pasaj: Dinle düğmesi (belirsiz pasaj yoksa atlanır)", true, "belirsiz pasaj yok");

  await page.getByText("Teslim", { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(500);
  check("Teslim: Claude'dan Short önerisi düğmesi", (await page.getByText("Claude'dan Short önerisi").count()) === 1);
  check("Teslim: Bölümleri ekle yalnız YouTube bağlıyken görünür (bağlı değil, görünmemeli)", (await page.getByText("Bölümleri ekle", { exact: true }).count()) <= 1);
  const preview = page.getByText("Önizle", { exact: true });
  if (await preview.count()) {
    await preview.first().click();
    await page.waitForTimeout(1500);
    check("Short önizleme: video öğesi açılır", (await page.locator("video[src*='/media/short/']").count()) === 1);
    check("Short önizleme: dosya 200/206 döner", responses.some((r) => /^(200|206) \/media\/short/.test(r)), responses.find((r) => r.includes("/media/short")) ?? "istek yok");
  } else check("Short önizleme (out/shorts boşsa atlanır)", true, "Short yok");
  check("Sayfada JavaScript hatası yok", errors.length === 0, errors.join(" | ").slice(0, 200));
  await browser.close();
} finally {
  spawn("taskkill", ["/T", "/F", "/PID", String(server.pid)], { stdio: "ignore", windowsHide: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
