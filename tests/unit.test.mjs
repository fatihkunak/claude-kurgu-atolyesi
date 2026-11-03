// Videosuz, tarayıcısız, FFmpeg'siz birim testleri: CI'da ve her yerde saniyeler içinde çalışır.
//   npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { correctedWords } from "../scripts/lib/caption-words.mjs";
import { cropXExpr, smooth } from "../scripts/lib/face-track.mjs";
import { planSchema } from "../src/plan/schema.ts";

test("Altyazı: düzeltilen kelime ham zamanını korur", () => {
  const raw = [["Bunlar", 3.46], ["acayip", 3.8], ["sıcak", 4.13], ["ya", 4.41]].map(([text, t]) => ({ t, text }));
  const out = correctedWords(raw, [{ start: 3, end: 5, text: "Burası acayip sıcak ya" }]);
  assert.deepEqual(out.map((x) => x.text), ["Burası", "acayip", "sıcak", "ya"]);
  assert.deepEqual(out.map((x) => x.t), [3.46, 3.8, 4.13, 4.41]);
});

test("Altyazı: eklenen kelimeye komşu zamanlar arasında süre verilir, zaman geri gitmez", () => {
  const raw = [["Burası", 3.46], ["sıcak", 4.13]].map(([text, t]) => ({ t, text }));
  const out = correctedWords(raw, [{ start: 3, end: 5, text: "Burası çok sıcak" }]);
  assert.equal(out.length, 3);
  assert.ok(out.every((x, i) => i === 0 || x.t >= out[i - 1].t));
});

test("Altyazı: düzeltme yoksa ham kelimeler olduğu gibi döner", () => {
  const raw = [{ t: 0.2, text: "Evet" }];
  assert.deepEqual(correctedWords(raw, null), raw);
});

test("Yüz izleme: boşluklar en yakın tespitle dolar, küçük titreme yok sayılır", () => {
  const out = smooth([{ t: 0, cx: 0.5 }, { t: 0.25, cx: null }, { t: 0.5, cx: 0.505 }, { t: 0.75, cx: 0.508 }]);
  assert.equal(out.length, 4);
  assert.ok(out.every((k) => k.cx != null));
  assert.equal(out[3].cx, out[0].cx); // %2'nin altındaki kayma kadrajı oynatmaz
});

test("Yüz izleme: gerçek bir sıçrama izlenir (kadraj yüzü takip eder)", () => {
  const out = smooth([0.3, 0.3, 0.3, 0.7, 0.7, 0.7].map((cx, i) => ({ t: i * 0.25, cx })));
  assert.ok(out.at(-1).cx > out[0].cx + 0.2);
});

test("Yüz izleme: hiç yüz yoksa null", () => {
  assert.equal(smooth([{ t: 0, cx: null }, { t: 0.25, cx: null }]), null);
});

test("Kırpma ifadesi: kadraj resmin dışına çıkmaz", () => {
  const e = cropXExpr([{ t: 0, cx: 0.05 }, { t: 1, cx: 0.95 }], 0, 0.4);
  assert.match(e, /^\(.*\)\*iw$/);
  const nums = [...e.matchAll(/(?<![\w.])0\.\d{4}(?![\w.])/g)].map((m) => Number(m[0]));
  assert.ok(nums.every((n) => n >= 0 && n <= 0.6 + 1e-9)); // 1 - 0.4
});

test("Kırpma ifadesi: tek anahtar sabit konum verir", () => {
  assert.equal(cropXExpr([{ t: 0, cx: 0.5 }], 0, 0.4), "0.3000*iw");
});

test("Plan şeması: örnek plan geçerli, bozuk olay reddedilir", () => {
  const example = JSON.parse(readFileSync(new URL("../library/examples/edit-plan.example.json", import.meta.url), "utf8"));
  assert.equal(planSchema.safeParse(example).success, true);
  const broken = structuredClone(example);
  broken.events[0].start = "başlangıç"; // süre sayı olmalı
  assert.equal(planSchema.safeParse(broken).success, false);
});
