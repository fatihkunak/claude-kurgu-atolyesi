// README ekran görüntüleri: paneli kendi portunda ve geçici veri klasöründe açıp dört sekmeyi çeker.
// Gerçek YouTube belirtecine dokunmaz (KURGU_DATA geçici klasör). Kullanım: npm run docs:screenshots
// Çıktı: docs/img/panel-{dokum,plan,render,teslim}.png (1440×900). Çalışma klasöründe bir proje (work/edit-plan.json) olmalı.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { p } from "./lib/paths.mjs";

const PORT = 3299;
const out = p("docs/img");
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ["studio/server.mjs"], {
  cwd: p(), stdio: "ignore", windowsHide: true,
  env: { ...process.env, STUDIO_NO_BROWSER: "1", STUDIO_PORT: String(PORT), KURGU_DATA: mkdtempSync(path.join(os.tmpdir(), "kurgu-shots-")) },
});
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* henüz açılmadı */ } await new Promise((r) => setTimeout(r, 250)); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1500);
  for (const [tab, file] of [["Döküm", "dokum"], ["Plan", "plan"], ["Render", "render"], ["Teslim", "teslim"]]) {
    await page.getByText(tab, { exact: true }).first().click();
    await page.waitForTimeout(1200);
    if (file === "teslim") await page.mouse.wheel(0, 1200), await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `panel-${file}.png`) });
    console.log("yazıldı:", `docs/img/panel-${file}.png`);
  }
  await browser.close();
} finally {
  spawn("taskkill", ["/T", "/F", "/PID", String(server.pid)], { stdio: "ignore", windowsHide: true });
}
