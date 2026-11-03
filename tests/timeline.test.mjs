// Timeline motoru birim testleri (video/DOM gerekmez):  node --test tests/timeline.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ZOOM_MAX, addZoom, dragZoom, removeZoomMove, setZoomMove, zoomAt, zoomLanes,
  addClip, addTrack, audioClipAt, audioSource, canRedo, canUndo, clipById, clipsInRect, clipsOn, closeGaps, commit, copyToClipboard, createHistory, createModel,
  deleteClips, duplicateClips, end, expandGroups, fromAssemble, groupClips, moveClips, pasteClipboard, redo, removeTrack, snapPoints,
  setTrack, snapTime, sourceTime, splitAt, timelineTime, videoClipAt, videoSource, chunkCount, chunkIndex, tickStep, timecode, toAssemble, toSelection, totalDuration, trimClip, undo,
} from "../studio/timeline/engine.mjs";

const FPS = 30;
const base = () => {
  let m = createModel({ fps: FPS });
  ({ model: m } = addClip(m, { trackId: "V1", src: "a.mp4", srcIn: 0, srcOut: 10 }));
  ({ model: m } = addClip(m, { trackId: "V1", src: "b.mp4", srcIn: 5, srcOut: 8 }));
  return m;
};

test("Klipler izin sonuna ardışık eklenir; süre toplamı doğru", () => {
  const m = base();
  assert.deepEqual(clipsOn(m, "V1").map((c) => [c.start, end(c)]), [[0, 10], [10, 13]]);
  assert.equal(totalDuration(m), 13);
});

test("Aynı izde çakışma reddedilir, model değişmez", () => {
  const m = base();
  assert.throws(() => moveClips(m, ["c2"], -2), /Çakışma/);
  assert.equal(clipById(m, "c2").start, 10);
});

test("Taşıma: 0'ın soluna çıkmaz; kare ızgarasına oturur", () => {
  let m = createModel({ fps: FPS });
  ({ model: m } = addClip(m, { src: "a", srcOut: 3 }));
  assert.equal(clipById(moveClips(m, ["c1"], -5), "c1").start, 0);
  assert.equal(clipById(moveClips(m, ["c1"], 0.1), "c1").start, 0.1);
  assert.equal(clipById(moveClips(m, ["c1"], 1 / 60), "c1").start, Math.round((1 / 60) * FPS) / FPS);
});

test("Mıknatıs: komşu klibin kenarına yapışır, eşik dışındaysa yapışmaz", () => {
  let m = createModel({ fps: FPS });
  ({ model: m } = addClip(m, { src: "a", srcOut: 4 })); // 0-4
  ({ model: m } = addClip(m, { src: "b", srcOut: 2 }, { at: 8 })); // 8-10
  const snapped = moveClips(m, ["c2"], -3.9, { snap: { threshold: 0.3 } });
  assert.equal(clipById(snapped, "c2").start, 4);
  const free = moveClips(m, ["c2"], -3.5, { snap: { threshold: 0.1 } });
  assert.ok(Math.abs(clipById(free, "c2").start - 4.5) < 1e-9);
  assert.equal(snapTime(4.2, snapPoints(m, { exclude: ["c2"] }), 0.3), 4);
});

test("Kırpma: sağ kenar kısaltır; sol kenar kaynağın girişini ilerletir; kaynak sınırını aşamaz", () => {
  let m = base();
  m = trimClip(m, "c1", "right", 6);
  assert.equal(clipById(m, "c1").srcOut, 6);
  m = trimClip(m, "c2", "left", 11);
  assert.equal(clipById(m, "c2").start, 11);
  assert.equal(clipById(m, "c2").srcIn, 6);
  const capped = trimClip(m, "c2", "right", 99, { srcMax: 9 });
  assert.equal(clipById(capped, "c2").srcOut, 9);
  assert.throws(() => trimClip(base(), "c1", "right", 12), /Çakışma/);
  assert.ok(end(clipById(trimClip(base(), "c1", "right", 0.01), "c1")) >= 0.1);
});

test("Bölme: iki parça, kaynak aralığı korunur, uç yakınında hata", () => {
  const { model: m, created } = splitAt(base(), 4);
  assert.equal(created.length, 1);
  const [a, b] = clipsOn(m, "V1");
  assert.deepEqual([a.start, a.srcIn, a.srcOut], [0, 0, 4]);
  assert.deepEqual([b.start, b.srcIn, b.srcOut], [4, 4, 10]);
  assert.throws(() => splitAt(base(), 0.05), /Bölünecek klip yok/);
  assert.throws(() => splitAt(base(), 9.99), /Bölünecek klip yok/);
});

test("Silme: ripple sağdakileri kaydırır, normal silme boşluk bırakır, kilitli iz silinmez", () => {
  const plain = deleteClips(base(), ["c1"]);
  assert.equal(clipById(plain, "c2").start, 10);
  const rip = deleteClips(base(), ["c1"], { ripple: true });
  assert.equal(clipById(rip, "c2").start, 0);
  const locked = { ...base(), tracks: base().tracks.map((t) => (t.id === "V1" ? { ...t, locked: true } : t)) };
  assert.throws(() => deleteClips(locked, ["c1"]), /Silinecek klip yok/);
  assert.throws(() => moveClips(locked, ["c1"], 1), /Kilitli/);
});

test("Çoğalt ve pano: yeni kimlikler; grup kimliği yeniden eşlenir; yapıştırma göreli konumu korur", () => {
  let m = groupClips(base(), ["c1", "c2"]);
  assert.deepEqual(expandGroups(m, ["c1"]).sort(), ["c1", "c2"]);
  const dup = duplicateClips(m, ["c1"]);
  assert.equal(dup.created.length, 2);
  const g = new Set(dup.created.map((id) => clipById(dup.model, id).groupId));
  assert.equal(g.size, 1);
  assert.ok(!g.has(clipById(m, "c1").groupId));
  const clip = copyToClipboard(base(), ["c2"]);
  const pasted = pasteClipboard(base(), clip, 20);
  assert.equal(clipById(pasted.model, pasted.created[0]).start, 20);
  assert.throws(() => pasteClipboard(base(), null, 0), /Pano boş/);
});

test("Çoklu seçim kutusu zaman aralığı ve izlere göre seçer", () => {
  const m = base();
  assert.deepEqual(clipsInRect(m, 9, 11, ["V1"]), ["c1", "c2"]);
  assert.deepEqual(clipsInRect(m, 11, 12, ["V1"]), ["c2"]);
  assert.deepEqual(clipsInRect(m, 0, 12, ["A1"]), []);
});

test("Boşlukları kapat; tür farkı: video klibi ses izine taşınamaz", () => {
  const gap = moveClips(base(), ["c2"], 2);
  assert.equal(clipById(closeGaps(gap, "V1"), "c2").start, 10);
  assert.throws(() => moveClips(base(), ["c2"], 0, { toTrack: "A1" }), /ses izine/);
});

test("Geri al/yinele: sınır 200, yeni işlem yineleme kuyruğunu siler, aynı model eklenmez", () => {
  let h = createHistory(createModel());
  const m1 = addClip(h.present, { src: "a", srcOut: 2 }).model;
  h = commit(h, m1);
  assert.equal(commit(h, m1), h);
  assert.ok(canUndo(h) && !canRedo(h));
  h = undo(h);
  assert.ok(canRedo(h));
  assert.equal(h.present.clips.length, 0);
  h = redo(h);
  assert.equal(h.present.clips.length, 1);
  h = undo(h);
  h = commit(h, addClip(h.present, { src: "b", srcOut: 1 }).model);
  assert.ok(!canRedo(h));
  let big = createHistory(createModel(), 200);
  for (let i = 0; i < 250; i++) big = commit(big, { ...createModel(), nextId: i + 2 });
  assert.equal(big.past.length, 200);
});

test("assemble.json: parçalar sırayla, boşluk hata, hepsi sdr ise çıktı sdr, gidiş-dönüş", () => {
  const spec = toAssemble(base());
  assert.deepEqual(spec.pieces.map((x) => [x.src, x.from, x.to]), [["a.mp4", 0, 10], ["b.mp4", 5, 8]]);
  assert.equal(spec.output, "hlg");
  assert.throws(() => toAssemble(moveClips(base(), ["c2"], 1)), /boşluk/);
  const sdr = createModel();
  const { model: s } = addClip(sdr, { src: "x", srcOut: 2, kind: "sdr", gainDb: -3 });
  assert.equal(toAssemble(s).output, "sdr");
  assert.equal(toAssemble(s).pieces[0].gainDb, -3);
  const back = fromAssemble(toAssemble(base()), FPS);
  assert.deepEqual(clipsOn(back, "V1").map((c) => [c.src, c.srcIn, c.srcOut, c.start]), [["a.mp4", 0, 10, 0], ["b.mp4", 5, 8, 10]]);
  assert.throws(() => toAssemble(createModel()), /video klibi yok/);
});

test("Zoom: ekle/değiştir/sil, sınırlar, rampa eğrisi, assemble'a yazılır ve geri okunur", () => {
  let { model: m, created } = addZoom(base(), { from: 2, to: 6, z: 1.2, cx: 0.4, in: 1, out: 1 });
  assert.deepEqual(m.zooms.map((z) => [z.id === created[0], z.from, z.to, z.z]), [[true, 2, 6, 1.2]]);
  assert.throws(() => addZoom(m, { from: 3, to: 3.01 }), /en az/);
  m = setZoomMove(m, created[0], { z: 9, cx: -1 });
  assert.equal(m.zooms[0].z, ZOOM_MAX); assert.equal(m.zooms[0].cx, 0);
  m = setZoomMove(m, created[0], { z: 1.2, cx: 0.4 });
  // kamera: dışarıda 1×, tam ortada (rampa bitti) 1.2×, rampanın yarısında smoothstep(0.5)=0.5 → 1.1×
  assert.equal(zoomAt(m.zooms, 1).z, 1);
  assert.ok(Math.abs(zoomAt(m.zooms, 4).z - 1.2) < 1e-9);
  assert.ok(Math.abs(zoomAt(m.zooms, 2.5).z - 1.1) < 1e-9);
  assert.equal(zoomAt(m.zooms, 6.5).z, 1);
  // kadraj sol-üst köşesi 08-assemble'ın crop ifadesiyle aynı: clip(Z·CX − 0.5, 0, Z − 1)
  const c = zoomAt(m.zooms, 4);
  assert.ok(Math.abs(c.x0 - Math.max(0, 1.2 * 0.4 - 0.5)) < 1e-9 && Math.abs(c.y0 - 0.1) < 1e-9);
  // rampa 0 → kesmede sert
  const hard = addZoom(base(), { from: 1, to: 2, z: 1.5, in: 0, out: 0 }).model;
  assert.equal(zoomAt(hard.zooms, 0.99).z, 1); assert.equal(zoomAt(hard.zooms, 1).z, 1.5); assert.equal(zoomAt(hard.zooms, 1.99).z, 1.5); assert.equal(zoomAt(hard.zooms, 2).z, 1);
  // assemble: kimliksiz, çıkış süresine kırpılı; dışarıda kalan atılır; geri okunur
  const far = addZoom(m, { from: 12, to: 20 }).model;
  const spec = toAssemble(addZoom(far, { from: 50, to: 52 }).model);
  assert.deepEqual(spec.zooms.map((z) => [z.from, z.to, z.z]), [[2, 6, 1.2], [12, 13, 1.12]]);
  assert.ok(spec.zooms.every((z) => !("id" in z)));
  const back = fromAssemble(spec, FPS);
  assert.deepEqual(back.zooms.map((z) => [z.from, z.to, z.z, z.cx, z.in, z.out]), [[2, 6, 1.2, 0.4, 1, 1], [12, 13, 1.12, 0.5, 0.3, 0.3]]);
  // eski kayıtlı model (zooms alanı yok) çökmez
  const { zooms: _drop, ...old } = base();
  assert.deepEqual(toAssemble(old).zooms, []);
  assert.equal(addZoom(old, { from: 0, to: 1 }).model.zooms.length, 1);
  assert.deepEqual(removeZoomMove(m, created[0]).zooms, []);
  // en kısa süre (0,1 sn) sınırında kayan nokta hatası hareketi reddetmez (kenardan sürüklerken)
  assert.doesNotThrow(() => setZoomMove(m, created[0], { from: 6 - 0.1 }));
  assert.throws(() => setZoomMove(m, created[0], { from: 6 - 0.05 }), /en az/);
});

test("Zoom sürükleme: mıknatıs klip kenarına/kafaya/diğer zoom'a yapışır, süre korunur, şeritler çakışmayı ayırır", () => {
  let { model: m, created } = addZoom(base(), { from: 2, to: 4 }); // klipler: 0–10, 10–13
  const id = created[0];
  const snap = { threshold: 0.2, playhead: 5 };
  // taşıma: sonu 10'a (klip kenarı) yapışır → başı 8, süre 2
  let r = dragZoom(m, id, "move", 5.9, { snap });
  assert.deepEqual([r.model.zooms[0].from, r.model.zooms[0].to, r.snapped], [8, 10, 10]);
  // mıknatıssız: kareye oturur, yapışmaz
  r = dragZoom(m, id, "move", 5.9, {});
  assert.ok(Math.abs(r.model.zooms[0].from - 7.9) < 1e-9 && r.snapped === null);
  // sağ kenar oynatma kafasına (5) yapışır; sol kenar 0'ın soluna çıkmaz, en az 0,1 sn kalır
  assert.equal(dragZoom(m, id, "right", 0.95, { snap }).model.zooms[0].to, 5);
  assert.equal(dragZoom(m, id, "left", -9, { snap }).model.zooms[0].from, 0);
  assert.ok(Math.abs(dragZoom(m, id, "left", 50, { snap }).model.zooms[0].to - dragZoom(m, id, "left", 50, { snap }).model.zooms[0].from - 0.1) < 1e-6);
  // diğer zoom'un kenarına yapışır
  ({ model: m } = addZoom(m, { from: 11.5, to: 12.5 }));
  assert.equal(dragZoom(m, id, "right", 7.4, { snap: { threshold: 0.2 } }).model.zooms[0].to, 11.5);
  assert.throws(() => dragZoom(m, "yok", "move", 1), /Zoom yok/);
  // şeritler: çakışanlar ayrı şeride, sonrası boşalan şeride döner
  const lanes = zoomLanes([{ id: "a", from: 0, to: 4 }, { id: "b", from: 2, to: 6 }, { id: "c", from: 4, to: 5 }, { id: "d", from: 6, to: 7 }]);
  assert.deepEqual([lanes.lane.a, lanes.lane.b, lanes.lane.c, lanes.lane.d, lanes.count], [0, 1, 0, 0, 2]);
  assert.deepEqual(zoomLanes([]), { lane: {}, count: 1 });
});

test("İz yönetimi: dolu iz silinmez, son iz silinmez; cetvel adımı zoomla küçülür; zaman kodu", () => {
  const m = addTrack(createModel(), "video");
  assert.equal(m.tracks[0].id, "V2");
  assert.throws(() => removeTrack(base(), "V1"), /İz boş değil/);
  assert.throws(() => removeTrack(createModel(), "V1"), /Son iz/);
  assert.ok(tickStep(8) < tickStep(0));
  assert.equal(timecode(61.5, 30), "01:01:15");
});

test("Müzik klibi: ses izinden selection alanları; birden fazla klip hata; sessiz iz yok sayılır; ses klibi video izine taşınamaz", () => {
  assert.equal(toSelection(base()), null); // ses izi boş
  let m = base();
  ({ model: m } = addClip(m, { trackId: "A1", src: "muzik.mp3", srcIn: 12, srcOut: 72, kind: "audio", gainDb: -2 }, { at: 4 }));
  assert.deepEqual(toSelection(m), { music: "muzik.mp3", musicPlace: { start: 4, in: 12, out: 72, gainDb: -2 } });
  assert.deepEqual(toAssemble(m).pieces.length, 2); // ses klibi videoya karışmaz
  const two = addClip(m, { trackId: "A1", src: "b.mp3", srcOut: 5, kind: "audio" }, { at: 70 }).model;
  assert.throws(() => toSelection(two), /tek müzik klibi/);
  assert.equal(toSelection(setTrack(m, "A1", { muted: true })), null);
  assert.throws(() => moveClips(m, [m.clips.at(-1).id], 0, { toTrack: "V1" }), /video klibi|ses klibi|izine taşınamaz/);
});

test("Oynatma: t anındaki klip (üst iz öncelikli, gizli iz yok sayılır), uçlarda yarı açık aralık, kaynak↔çizelge saati", () => {
  let m = base(); // V1: a 0-10, b 10-13
  assert.equal(videoClipAt(m, 0).id, "c1");
  assert.equal(videoClipAt(m, 9.999).id, "c1");
  assert.equal(videoClipAt(m, 10).id, "c2"); // sınır: sonraki klip
  assert.equal(videoClipAt(m, 13), null);
  m = addTrack(m, "video"); // V2 en üstte
  ({ model: m } = addClip(m, { trackId: "V2", src: "ust.mp4", srcOut: 2 }, { at: 1 }));
  assert.equal(videoClipAt(m, 1.5).label, "ust.mp4");
  assert.equal(videoClipAt(setTrack(m, "V2", { hidden: true }), 1.5).label, "a.mp4");
  const b = clipById(m, "c2");
  assert.equal(sourceTime(b, 11), 6); // srcIn 5
  assert.equal(timelineTime(b, 6), 11);
  ({ model: m } = addClip(m, { trackId: "A1", src: "m.wav", srcIn: 4, srcOut: 14, kind: "audio" }, { at: 2 }));
  assert.equal(audioClipAt(m, 3).src, "m.wav");
  assert.equal(audioClipAt(m, 12), null);
  assert.equal(audioClipAt(setTrack(m, "A1", { muted: true }), 3), null);
});

test("Video klibi: hasAudio bayrağı korunur, bölünen parçalar da taşır", () => {
  let m = createModel({ fps: 30 });
  ({ model: m } = addClip(m, { trackId: "V1", src: "v.mp4", srcOut: 10, fileId: "f1", hasAudio: true }));
  ({ model: m } = addClip(m, { trackId: "V1", src: "s.mp4", srcOut: 2, fileId: "f2" })); // sessiz kaynak
  assert.equal(clipById(m, "c1").hasAudio, true);
  assert.equal("hasAudio" in clipById(m, "c2"), false);
  const { model: s } = splitAt(m, 4);
  assert.equal(s.clips.filter((c) => c.hasAudio).length, 2);
});

test("Proxy parçaları: kaynak saniyesi 60 sn'lik parçaya eşlenir; hazır olmayan parça null; ses özgün dosyadan", () => {
  assert.equal(chunkIndex(0), 0);
  assert.equal(chunkIndex(59.999), 0);
  assert.equal(chunkIndex(60), 1);
  assert.equal(chunkCount(130), 3);
  assert.equal(chunkCount(60), 1);
  assert.equal(chunkCount(60.2), 2);
  let m = createModel({ fps: 30 });
  ({ model: m } = addClip(m, { trackId: "V1", src: "u.mp4", srcIn: 50, srcOut: 130, fileId: "f1" })); // çizelge 0–80, kaynak 50–130
  const c = m.clips[0];
  const files = { f1: { chunks: [true, false, true] } };
  assert.deepEqual(videoSource(c, 5, files), { url: "/api/montage/media?id=f1&chunk=0", want: 55 });
  assert.equal(videoSource(c, 15, files), null); // kaynak 65 sn → parça 1 henüz yok
  assert.deepEqual(videoSource(c, 75, files), { url: "/api/montage/media?id=f1&chunk=2", want: 5 }); // kaynak 125 → parça 2, yerel 5
  assert.equal(videoSource(c, 5, {}), null);
  assert.equal(videoSource(c, 5, { f1: { chunks: null } }), null);
  const a = { fileId: "m1", start: 2, srcIn: 10, srcOut: 40 };
  assert.deepEqual(audioSource(a, 12), { url: "/api/montage/media?id=m1", want: 20 });
});
