// Gizlilik sunucu modülü (geçici kök, video yok):  node --test tests/privacy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createPrivacy, excludeFor, validBoxes } from "../studio/privacy.mjs";

let root, pr;
const readJson = (f, fb = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } };
const track = (id, samples, extra = {}) => ({ id, start: samples[0][0], end: samples.at(-1)[0] + 0.1, hits: samples.length, maxScore: 0.9, maxSizePx: Math.max(...samples.map((s) => s[3])), samples, ...extra });

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "kurgu-privacy-"));
  mkdirSync(path.join(root, "work/privacy"), { recursive: true });
  writeFileSync(path.join(root, "work/privacy/proposals.json"), JSON.stringify({ padding: 0.35, tracks: [
    track("F001", [[0, 100, 200, 80, 100], [0.1, 120, 210, 80, 100]]),
    track("F002", [[5, 1000, 500, 30, 30], [5.1, 1002, 501, 30, 30]]), // 30 px: eşiğin altı
    track("F003", [[9, 2000, 900, 60, 60], [9.1, 2000, 900, 60, 60]]),
  ] }));
  pr = createPrivacy({ p: (...x) => path.join(root, ...x), ROOT: root, readJson, send: () => {}, jobRunning: () => false, SOURCE: "x.mov" });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("excludeFor: örneklerin birleşimi + pay, süre izin kendisi", () => {
  const e = excludeFor(track("F", [[0, 100, 200, 80, 100], [0.1, 120, 210, 80, 100]]), 0.1);
  assert.deepEqual([e.start, e.end], [0, 0.2]);
  // birleşim: x 100..200, y 200..310 → 100x110, pay %10
  assert.deepEqual([e.x, e.y, e.w, e.h], [90, 189, 120, 132]);
  const edge = excludeFor(track("G", [[1, 0, 0, 50, 50]]), 0.5);
  assert.equal(edge.x, 0); // negatife taşmaz
});

test("validBoxes: sonlu sayı, pozitif boyut, start<end, şekil", () => {
  assert.equal(validBoxes([{ start: 1, end: 2, x: 0, y: 0, w: 100, h: 50 }]), null);
  assert.match(validBoxes([{ start: 2, end: 1, x: 0, y: 0, w: 100, h: 50 }]), /süre/);
  assert.match(validBoxes([{ start: 1, end: 2, x: 0, y: 0, w: 2, h: 50 }]), /boyut/);
  assert.match(validBoxes([{ start: 1, end: "a", x: 0, y: 0, w: 9, h: 9 }]), /geçersiz/);
  assert.match(validBoxes([{ start: 1, end: 2, x: 0, y: 0, w: 9, h: 9, shape: "star" }]), /Şekil/);
  assert.match(validBoxes("x"), /liste/);
});

test("Durum: eşik altı izler listelenmez; iz sayısı toplamı gösterir", () => {
  let got;
  const send = (res, code, body) => { got = body; };
  const p2 = createPrivacy({ p: (...x) => path.join(root, ...x), ROOT: root, readJson, send, jobRunning: () => false, SOURCE: "x.mov" });
  return p2.get(new URL("http://x/api/privacy"), {}, {}).then(() => {
    assert.deepEqual(got.tracks.map((t) => t.id), ["F001", "F003"]);
    assert.equal(got.total, 3);
    assert.equal(got.project.enabled, false);
  });
});

test("Atla: approved.json'a skipIds ve exclude yazılır; bilinmeyen kimlik reddedilir; sıfırlanabilir", () => {
  assert.equal(pr.post["/api/privacy/skip"]({ ids: ["F999"] })[0], 422);
  assert.equal(pr.post["/api/privacy/skip"]({ ids: ["F003"] })[0], 200);
  const cfg = readJson(path.join(root, "work/privacy/approved.json"));
  assert.deepEqual(cfg.skipIds, ["F003"]);
  assert.equal(cfg.exclude.length, 1);
  assert.equal(cfg.exclude[0].id, "F003");
  assert.equal(pr.post["/api/privacy/skip"]({ ids: [] })[0], 200);
  assert.deepEqual(readJson(path.join(root, "work/privacy/approved.json")).exclude, []);
});

test("Eşik ve elle kutu: aralık dışı reddedilir; geçerli olan manual.json'a yazılır; maske yokken etkinleştirme reddedilir", () => {
  assert.equal(pr.post["/api/privacy/threshold"]({ minSizePx: 5, minScore: 0.6 })[0], 422);
  assert.equal(pr.post["/api/privacy/threshold"]({ minSizePx: 60, minScore: 0.7 })[0], 200);
  assert.equal(readJson(path.join(root, "work/privacy/approved.json")).minSizePx, 60);
  assert.equal(pr.post["/api/privacy/manual"]({ boxes: [{ start: 1, end: 0.5, x: 1, y: 1, w: 20, h: 20 }] })[0], 422);
  assert.equal(pr.post["/api/privacy/manual"]({ boxes: [{ start: 1, end: 2.5, x: 10.4, y: 20.6, w: 300, h: 90, shape: "ellipse" }] })[0], 200);
  assert.deepEqual(readJson(path.join(root, "work/privacy/manual.json")), [{ start: 1, end: 2.5, x: 10, y: 21, w: 300, h: 90, shape: "ellipse" }]);
  assert.equal(pr.post["/api/privacy/enable"]({ on: true })[0], 422);
  assert.equal(pr.post["/api/privacy/run"]({ step: "mask" })[0], 422); // faces.raw.json yok
  assert.equal(pr.post["/api/privacy/run"]({ step: "rm -rf" })[0], 422);
});
