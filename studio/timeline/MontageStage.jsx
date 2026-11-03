// "Montaj" aşaması: birden çok klibi tek zaman çizelgesinde birleştirir → work/assemble.json → 08-assemble.mjs.
// Timeline mantığı: ./engine.mjs (testli). Burada durum (geri al geçmişi), kısayollar, klip kutusu, özellikler, önizleme.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HISTORY_LIMIT, addClip, addTrack, audioClipAt, canRedo, canUndo, clipById, closeGaps, commit as commitHistory, copyToClipboard, createHistory, createModel,
  deleteClips, dur, duplicateClips, end, groupClips, pasteClipboard, redo, setClip, sourceTime, splitAt, timeToX, timecode, totalDuration, ungroupClips, undo, videoClipAt, videoSource, audioSource,
  ZOOM_MAX, ZOOM_MIN, addZoom, removeZoomMove, setZoomMove, zoomAt,
} from "./engine.mjs";
import { LABEL_W, Timeline } from "./Timeline.jsx";

const SHORTCUTS = [
  ["Boşluk", "Oynat / durdur (düşük çözünürlüklü proxy; ses dahil)"],
  ["← / →", "1 kare geri/ileri (Shift: 1 sn)"],
  ["Home / End", "Başa / sona git"],
  ["S", "Oynatma kafasından böl (seçiliyse yalnız seçili klipleri)"],
  ["Delete", "Sil · Shift+Delete: ripple sil (boşluğu kapat) · seçili zoom'u da siler"],
  ["Ctrl+D", "Çoğalt (aynı izde hemen sonrasına; seçili zoom'u da)"],
  ["Ctrl+C / Ctrl+V", "Kopyala / oynatma kafasına yapıştır"],
  ["Ctrl+A", "Hepsini seç"],
  ["Ctrl+G / Ctrl+Shift+G", "Grupla / grubu çöz"],
  ["Ctrl+Z / Ctrl+Y", "Geri al / yinele (en fazla 200)"],
  ["M", "Mıknatısı aç/kapat"],
  ["Z", "Oynatma kafasına zoom (punch-in) ekle; sağ paneldeki Kamera listesinden ayarlanır"],
  ["Ctrl+tekerlek", "Yakınlaştır (imleç noktasında)"],
  ["Shift/Ctrl+tık", "Seçime ekle/çıkar · boşlukta sürükle: kutu seçimi"],
  ["?", "Bu pencere"],
];

const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `Hata ${r.status}`);
  return data;
};
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const mb = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

export function MontageStage({ onDone, setError }) {
  const [srv, setSrv] = useState(null); // { model, bin, build }
  const [hist, setHist] = useState(() => createHistory(createModel()));
  const [selected, setSelected] = useState([]);
  const [selZoom, setSelZoom] = useState(null);
  const [dragModel, setDragModel] = useState(null);
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(2);
  const [snapOn, setSnapOn] = useState(true);
  const [clipboard, setClipboard] = useState(null);
  const [help, setHelp] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const scrollRef = useRef(null);
  const ready = useRef(false);
  const model = hist.present;

  const load = useCallback(async () => {
    const s = await (await fetch("/api/montage")).json();
    setSrv(s);
    if (!ready.current) {
      ready.current = true;
      if (s.model) setHist(createHistory(s.model));
    }
    return s;
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load, setError]);
  // proxy hazırlanırken durumu yokla; kutuda olup proxy'si hiç başlatılmamış (eski) dosyalar için bir kez iste
  const proxyAsked = useRef(new Set());
  const anyBuilding = (srv?.bin ?? []).some((f) => f.proxy === "building");
  useEffect(() => {
    for (const f of srv?.bin ?? []) if (f.proxy === "missing" && !proxyAsked.current.has(f.id)) { proxyAsked.current.add(f.id); post("/api/montage/proxy", { id: f.id }).then(() => load()).catch(() => {}); }
    if (!anyBuilding) return undefined;
    const id = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(id);
  }, [srv?.bin, anyBuilding, load]);
  // birleştirme sürerken durumu yokla
  useEffect(() => {
    if (srv?.build.state !== "running") return undefined;
    const id = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(id);
  }, [srv?.build.state, load]);

  // her işlem tek noktadan: hata → kullanıcıya, model değişmez
  const apply = useCallback((fn) => {
    try {
      const out = fn(hist.present);
      const next = out && out.model ? out.model : out;
      if (next) setHist((h) => commitHistory(h, next));
      return out;
    } catch (e) { setError(e.message); return null; }
  }, [hist.present, setError]);
  const commit = useCallback((next) => setHist((h) => commitHistory(h, next)), []);

  // otomatik kaydet (geri al geçmişi sunucuya gitmez, yalnız son model)
  useEffect(() => {
    if (!ready.current || !model.clips.length && !srv?.model) return undefined;
    setSaved("Kaydediliyor…");
    const id = setTimeout(() => post("/api/montage/save", { model }).then(() => setSaved("Kaydedildi")).catch((e) => setSaved(`Kaydedilmedi: ${e.message}`)), 600);
    return () => clearTimeout(id);
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = srv?.bin ?? [];
  const fileById = useMemo(() => Object.fromEntries(files.map((f) => [f.id, f])), [files]);
  const fps = model.fps;
  const frame = 1 / fps;
  const total = totalDuration(model);

  const addFile = (f, at) => apply((m) => {
    if (f.kind === "audio") { // müzik: ilk açık ses izine, oynatma kafasının olduğu saniyeye (hat tek müzik klibi destekler)
      const trk = m.tracks.find((t) => t.kind === "audio" && !t.locked);
      if (!trk) throw new Error("Açık ses izi yok.");
      return addClip(m, { trackId: trk.id, src: f.src, label: f.name, kind: "audio", srcIn: 0, srcOut: f.duration, fileId: f.id, srcMax: f.duration }, { at: at ?? playhead });
    }
    let base = m;
    if (!m.clips.length && Math.abs(f.fps - m.fps) > 0.01) base = { ...m, fps: Math.round(f.fps * 1000) / 1000 }; // ilk klip hattın kare hızını belirler
    else if (Math.abs(f.fps - m.fps) > 0.01) throw new Error(`Kare hızı uyuşmuyor: ${f.name} ${f.fps.toFixed(2)} fps, hat ${m.fps} fps. Aynı kare hızında klipler birleştirilir.`);
    return addClip(base, { trackId: base.tracks.find((t) => t.kind === "video").id, src: f.src, label: f.name, kind: f.kind, srcIn: 0, srcOut: f.duration, fileId: f.id, srcMax: f.duration, hasAudio: f.hasAudio }, { at });
  });

  const addPath = async () => {
    if (!path.trim()) return;
    setBusy(true);
    try { const r = await post("/api/montage/add", { path }); setPath(""); await load(); if (r.file) addFile(r.file); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const removeFile = async (id) => { try { await post("/api/montage/remove", { id }); await load(); } catch (e) { setError(e.message); } };

  const doSplit = () => apply((m) => splitAt(m, playhead, selected.length ? selected : undefined));
  const doDelete = (ripple) => {
    if (!selected.length && selZoom) { apply((m) => removeZoomMove(m, selZoom)); setSelZoom(null); return; }
    if (selected.length && apply((m) => deleteClips(m, selected, { ripple }))) setSelected([]);
  };
  const doDup = () => {
    const zm = !selected.length && selZoom && (model.zooms ?? []).find((x) => x.id === selZoom);
    if (zm) { const r = apply((m) => addZoom(m, { ...zm, from: zm.to, to: zm.to + (zm.to - zm.from) })); if (r) setSelZoom(r.created[0]); return; } // seçili zoom: hemen sonrasına kopya
    const r =apply((m) => duplicateClips(m, selected)); if (r) setSelected(r.created); };
  const doCopy = () => setClipboard(copyToClipboard(model, selected));
  const doPaste = () => { const r = apply((m) => pasteClipboard(m, clipboard, playhead)); if (r) setSelected(r.created); };
  const doAddZoom = () => {
    if (total <= 0) return;
    if (playhead >= total - frame / 2) { setError("Zoom için oynatma kafasını videonun içine koy (sonunda süre yok)."); return; }
    const r = apply((m) => addZoom(m, { from: playhead, to: Math.min(playhead + 2, Math.max(totalDuration(m), playhead + 0.1)) }));
    if (r) { setSelZoom(r.created[0]); setSelected([]); }
  };
  const videoTrack = [...model.tracks].reverse().find((t) => t.kind === "video").id;

  // kısayollar (yazı alanındayken devre dışı)
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      const run = (fn) => { e.preventDefault(); fn(); };
      if (mod && k === "z" && !e.shiftKey) return run(() => setHist(undo));
      if (mod && (k === "y" || (k === "z" && e.shiftKey))) return run(() => setHist(redo));
      if (mod && k === "d") return run(doDup);
      if (mod && k === "c") return run(doCopy);
      if (mod && k === "v") return run(doPaste);
      if (mod && k === "a") return run(() => setSelected(model.clips.map((c) => c.id)));
      if (mod && k === "g") return run(() => (e.shiftKey ? apply((m) => ungroupClips(m, selected)) : selected.length > 1 && apply((m) => groupClips(m, selected))));
      if (mod) return;
      if (k === "s") return run(doSplit);
      if (k === "m") return run(() => setSnapOn((v) => !v));
      if (k === "z") return run(doAddZoom);
      if (k === "delete" || k === "backspace") return run(() => doDelete(e.shiftKey));
      if (k === "arrowleft") return run(() => setPlayhead((t) => Math.max(0, t - (e.shiftKey ? 1 : frame))));
      if (k === "arrowright") return run(() => setPlayhead((t) => t + (e.shiftKey ? 1 : frame)));
      if (k === "home") return run(() => setPlayhead(0));
      if (k === "end") return run(() => setPlayhead(total));
      if (k === " ") return run(togglePlay);
      if (k === "?" || (e.shiftKey && k === "/")) return run(() => setHelp((v) => !v));
      if (k === "escape") { setHelp(false); setSelected([]); setSelZoom(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── önizleme ve oynatma ──────────────────────────────────────────────────────────────────────
  // Video proxy'si (640 px, sunucuda üretilir) <video>'ya, müzik <audio>'ya verilir; ikisi de çizelge saatine (duvar saati) bağlanır,
  // 0,4 sn'den fazla sapınca yeniden konumlanır. Bölünmüş (aynı dosyadan ardışık) klipler arasında kaynak değişmez → kesintisiz.
  const videoRef = useRef(null), audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const live = useRef({});
  live.current = { model, fileById, total, playhead };
  const under = videoClipAt(model, playhead);
  const vsrc = under ? videoSource(under, playhead, fileById) : null; // o anki 60 sn'lik proxy parçası (hazır değilse null)
  const videoReady = !!vsrc;
  const bind = (el, url, then) => { // kaynağı değiştir (gerekirse) ve yüklenince then()
    if (el.getAttribute("data-url") !== url) { el.setAttribute("data-url", url); el.src = url; el.addEventListener("loadedmetadata", then, { once: true }); } else if (el.readyState >= 1) then(); else el.addEventListener("loadedmetadata", then, { once: true });
  };
  const togglePlay = () => setPlaying((p) => { if (!p && live.current.playhead >= live.current.total - 0.05) setPlayhead(0); return !p; });

  useEffect(() => { // dururken: kare gezinme (proxy hazırsa <video> karesi, değilse küçük resim)
    const v = videoRef.current;
    if (playing || !v) return;
    if (!vsrc) { v.pause(); return; }
    bind(v, vsrc.url, () => { v.currentTime = videoSource(under, live.current.playhead, live.current.fileById)?.want ?? 0; });
    v.pause();
  }, [playing, under?.id, vsrc?.url, Math.round(playhead * fps)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // çalarken
    const v = videoRef.current, a = audioRef.current;
    if (!playing) { v?.pause(); a?.pause(); return undefined; }
    let last = performance.now(), t = live.current.playhead, lastUi = 0;
    const slave = (el, c, resolve, volume) => { // resolve(c, t) → { url, want } | null (parça hazır değil)
      if (!el) return;
      if (!c) { el.pause(); return; }
      const src = resolve(c, t);
      if (!src) { el.pause(); return; }
      const { url, want } = src;
      if (el.getAttribute("data-url") !== url) { // yeni klip ya da yeni 60 sn'lik parça
        el.setAttribute("data-url", url); el.src = url;
        el.addEventListener("loadedmetadata", () => { el.currentTime = resolve(c, t)?.want ?? want; el.volume = volume; el.play().catch(() => {}); }, { once: true });
        return;
      }
      el.volume = volume;
      if (el.readyState >= 3 && Math.abs(el.currentTime - want) > 0.4) el.currentTime = want;
      if (el.paused && el.readyState >= 2) el.play().catch(() => {});
    };
    // saat: setInterval (rAF arka plandaki/örtülü pencerelerde saniyede 1'e düşer; medya zaten kendi saatiyle çalar)
    const tick = () => {
      const now = performance.now();
      const { model: m, fileById: fb, total: tot } = live.current;
      t += (now - last) / 1000; last = now;
      if (t >= tot) { clearInterval(timer); setPlayhead(tot); setPlaying(false); return; }
      slave(v, videoClipAt(m, t), (c, tt) => videoSource(c, tt, fb), 1);
      const ac = audioClipAt(m, t);
      slave(a, ac, audioSource, Math.min(1, 0.6 * 10 ** ((ac?.gainDb ?? 0) / 20)));
      if (now - lastUi > 30) { lastUi = now; setPlayhead(t); }
    };
    const timer = setInterval(tick, 20);
    return () => { clearInterval(timer); v?.pause(); a?.pause(); };
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { // çalarken oynatma kafası görünür kalsın
    const el = scrollRef.current;
    if (!playing || !el) return;
    const x = LABEL_W + timeToX(playhead, zoom);
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft + LABEL_W) el.scrollLeft = Math.max(0, x - LABEL_W - 120);
  }, [playing, playhead, zoom]);

  // proxy yoksa küçük resim
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (!under?.fileId || videoReady) { setShown(null); return undefined; }
    const id = setTimeout(() => setShown(`/api/montage/thumb?id=${under.fileId}&t=${(under.srcIn + (playhead - under.start)).toFixed(1)}&w=640`), 120);
    return () => clearTimeout(id);
  }, [under?.id, under?.fileId, videoReady, Math.round(playhead * 10)]); // eslint-disable-line react-hooks/exhaustive-deps

  const cam = zoomAt((dragModel ?? model).zooms, playhead); // sürüklerken taslakla: önizleme anında tepki verir
  const camStyle = { transformOrigin: "0 0", transform: cam.z > 1 ? `translate(${-cam.x0 * 100}%, ${-cam.y0 * 100}%) scale(${cam.z})` : "none" };
  const sel1 = selected.length === 1 ? clipById(model, selected[0]) : null;
  const build = srv?.build ?? { state: "idle" };
  const buildNow = async () => {
    setBusy(true);
    try { await post("/api/montage/build", { model }); await load(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const Btn = ({ icon, title, onClick, disabled, on }) => (
    <button className={`tm-tb${on ? " on" : ""}`} style={{ width: 28, height: 28, fontSize: 15, opacity: disabled ? 0.35 : 1 }} title={title} aria-label={title} disabled={disabled} onClick={onClick}><i className={icon} /></button>
  );

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr) minmax(220px,42%)" }}>
      {/* klip kutusu */}
      <div className="col" style={{ gridRow: "1 / -1", background: "var(--s1)", borderRight: "1px solid var(--b1)", minHeight: 0 }}>
        <div style={{ padding: "12px 12px 8px", fontWeight: 600 }}>Klip kutusu</div>
        <div style={{ display: "flex", gap: 6, padding: "0 12px 10px" }}>
          <input className="field" aria-label="Video dosya yolu" placeholder="C:\…\klip.mp4" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPath()} />
          <button className="btn sm" disabled={busy || !path.trim()} onClick={addPath}><i className="icon-folder-plus" />Ekle</button>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "0 8px 12px" }}>
          {!files.length && <p className="t3 s12" style={{ padding: "0 4px", lineHeight: 1.5 }}>Birleştirmek istediğin videoların (ve müzik dosyasının) tam yolunu yapıştır (Dosya Gezgini → Shift+sağ tık → Yol olarak kopyala). Dosyalar kopyalanmaz, özgün hâlleri değişmez.</p>}
          {files.map((f) => (
            <div key={f.id} style={{ display: "grid", gridTemplateColumns: "64px minmax(0,1fr) auto", gap: 8, padding: 6, borderRadius: 6, alignItems: "center" }} className="binrow">
              {f.kind === "audio"
                ? <div aria-hidden style={{ width: 64, height: 36, borderRadius: 4, background: "var(--well)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t3)", fontSize: 18 }}><i className="icon-music" /></div>
                : <img alt="" src={`/api/montage/thumb?id=${f.id}&t=${Math.min(1, f.duration / 2).toFixed(1)}&w=128`} style={{ width: 64, height: 36, objectFit: "cover", borderRadius: 4, background: "var(--well)" }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.path}>{f.name}</div>
                <div className="mono t3" style={{ fontSize: 10 }}>{f.kind === "audio" ? `${fmt(f.duration)} · SES (müzik) · ${mb(f.size)}` : `${fmt(f.duration)} · ${f.width}×${f.height} · ${f.fps.toFixed(0)} fps · ${f.kind.toUpperCase()} · ${mb(f.size)}`}{f.proxy === "building" || f.proxy === "missing" ? ` · proxy ${f.chunks ? f.chunks.filter(Boolean).length : 0}/${f.chunks?.length ?? "?"}` : ""}{f.proxy === "failed" ? ` · proxy hatası: ${f.proxyError ?? ""}` : ""}</div>
              </div>
              <div style={{ display: "flex", gap: 2 }}>
                <button className="tm-tb" title="Zaman çizelgesine ekle" aria-label={`${f.name} ekle`} onClick={() => addFile(f)}><i className="icon-plus" /></button>
                <button className="tm-tb" title="Kutudan kaldır" aria-label={`${f.name} kaldır`} onClick={() => removeFile(f.id)}><i className="icon-x" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* önizleme + özellikler */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 280px", minHeight: 0, borderBottom: "1px solid var(--b1)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#050505", minHeight: 0, position: "relative", containerType: "size" }}>
          {/* 16:9 çerçeve: zoom, 08-assemble'ın kırpmasıyla aynı formülle (zoomAt) çerçevenin içinde kırpılır */}
          <div data-testid="preview-frame" style={{ width: "min(100cqw, 100cqh * 16 / 9)", aspectRatio: "16 / 9", overflow: "hidden", position: "relative", display: videoReady || shown ? "block" : "none" }}>
            <video ref={videoRef} playsInline preload="auto" aria-label="Önizleme" style={{ ...camStyle, width: "100%", height: "100%", objectFit: "contain", display: videoReady ? "block" : "none", background: "#000" }} />
            {!videoReady && shown && <img alt="Önizleme karesi" src={shown} style={{ ...camStyle, width: "100%", height: "100%", objectFit: "contain" }} />}
          </div>
          <audio ref={audioRef} preload="auto" />
          {!videoReady && !shown && <span className="t3">{!model.clips.length ? "Soldan klip ekle" : !under ? "Oynatma kafası klipsiz bir yerde" : "Proxy hazırlanıyor…"}</span>}
          <span className="mono" style={{ position: "absolute", left: 10, bottom: 8, fontSize: 12, background: "rgba(0,0,0,.6)", padding: "2px 6px", borderRadius: 4 }}>{timecode(playhead, fps)} / {timecode(total, fps)}</span>
        </div>
        <div className="col" style={{ background: "var(--s1)", borderLeft: "1px solid var(--b1)", padding: 12, gap: 10, overflow: "auto" }}>
          <div style={{ fontWeight: 600 }}>{sel1 ? "Klip" : selected.length ? `${selected.length} klip seçili` : "Özellikler"}</div>
          {sel1 ? <Props key={`${sel1.id}:${sel1.start}:${sel1.srcIn}:${sel1.srcOut}:${sel1.gainDb}`} clip={sel1} fps={fps} apply={apply} file={fileById[sel1.fileId]} /> : <span className="t3 s12" style={{ lineHeight: 1.5 }}>{selected.length ? "Birlikte taşı, böl, sil, çoğalt. Ctrl+G ile grupla." : "Bir klibe tıkla. Kenarlarından kırp, gövdesinden taşı."}</span>}
          <ZoomPanel zooms={model.zooms ?? []} selZoom={selZoom} setSelZoom={setSelZoom} playhead={playhead} setPlayhead={setPlayhead} apply={apply} onAdd={doAddZoom} canAdd={total > 0} />
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {build.state === "running" && <div className="mono t2 s12" style={{ lineHeight: 1.5 }}>Birleştiriliyor ({build.pieces} parça)…{(build.log ?? []).slice(-2).map((l, i) => <div key={i} className="t3" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.slice(-60)}</div>)}</div>}
            {build.state === "done" && <div className="s12" style={{ color: "var(--accent)" }}>Birleştirildi. Sıradaki: Döküm.</div>}
            {build.state === "failed" && <div className="s12" style={{ color: "var(--neg)" }}>{build.error}</div>}
            <button className="btn y" disabled={busy || !model.clips.length || build.state === "running"} onClick={buildNow}><i className="icon-film" />Birleştir (08-assemble)</button>
            {build.state === "done" && <button className="btn" onClick={onDone}>Dökümle devam</button>}
            <span className="t3" style={{ fontSize: 11 }}>{saved}</span>
          </div>
        </div>
      </div>

      {/* araç çubuğu + timeline */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="tm-tools" style={{ background: "var(--s1)", borderBottom: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 2, padding: "4px 10px", flexWrap: "wrap" }}>
          <Btn icon={playing ? "icon-pause" : "icon-play"} title={playing ? "Durdur (Boşluk)" : "Oynat (Boşluk)"} on={playing} onClick={togglePlay} disabled={!total} />
          <span className="tm-sep" />
          <Btn icon="icon-undo-2" title="Geri al (Ctrl+Z)" onClick={() => setHist(undo)} disabled={!canUndo(hist)} />
          <Btn icon="icon-redo-2" title="Yinele (Ctrl+Y)" onClick={() => setHist(redo)} disabled={!canRedo(hist)} />
          <span className="tm-sep" />
          <Btn icon="icon-scissors" title="Böl (S)" onClick={doSplit} disabled={!model.clips.length} />
          <Btn icon="icon-trash-2" title="Sil (Delete)" onClick={() => doDelete(false)} disabled={!selected.length} />
          <Btn icon="icon-chevrons-left-right" title="Ripple sil (Shift+Delete)" onClick={() => doDelete(true)} disabled={!selected.length} />
          <Btn icon="icon-copy-plus" title="Çoğalt (Ctrl+D)" onClick={doDup} disabled={!selected.length} />
          <Btn icon="icon-copy" title="Kopyala (Ctrl+C)" onClick={doCopy} disabled={!selected.length} />
          <Btn icon="icon-clipboard-paste" title="Yapıştır (Ctrl+V)" onClick={doPaste} disabled={!clipboard} />
          <Btn icon="icon-link" title="Grupla (Ctrl+G)" onClick={() => apply((m) => groupClips(m, selected))} disabled={selected.length < 2} />
          <Btn icon="icon-link-2-off" title="Grubu çöz (Ctrl+Shift+G)" onClick={() => apply((m) => ungroupClips(m, selected))} disabled={!selected.length} />
          <span className="tm-sep" />
          <Btn icon="icon-magnet" title="Mıknatıs (M)" on={snapOn} onClick={() => setSnapOn((v) => !v)} />
          <Btn icon="icon-align-horizontal-justify-start" title="Boşlukları kapat (video izi)" onClick={() => apply((m) => closeGaps(m, videoTrack))} disabled={!model.clips.length} />
          <Btn icon="icon-film" title="Video izi ekle" onClick={() => apply((m) => addTrack(m, "video"))} />
          <Btn icon="icon-audio-lines" title="Ses izi ekle" onClick={() => apply((m) => addTrack(m, "audio"))} />
          <span className="tm-sep" />
          <Btn icon="icon-zoom-out" title="Uzaklaştır" onClick={() => setZoom((z) => Math.max(-6, z - 1))} />
          <Btn icon="icon-zoom-in" title="Yakınlaştır" onClick={() => setZoom((z) => Math.min(14, z + 1))} />
          <Btn icon="icon-maximize-2" title="Hepsini sığdır" onClick={() => { const w = (scrollRef.current?.clientWidth ?? 900) - 200; let z = -6; while (z < 14 && total * 20 * Math.pow(1.35, z + 1) < w) z++; setZoom(z); if (scrollRef.current) scrollRef.current.scrollLeft = 0; }} disabled={!total} />
          <span style={{ flex: 1 }} />
          <span className="mono t3" style={{ fontSize: 11 }}>{model.clips.length} klip · {fmt(total)} · {fps} fps · {hist.past.length}/{HISTORY_LIMIT}</span>
          <Btn icon="icon-keyboard" title="Kısayollar (?)" onClick={() => setHelp(true)} />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Timeline model={model} commit={commit} playhead={playhead} setPlayhead={setPlayhead} selected={selected} setSelected={setSelected}
            thumbsOk snapOn={snapOn} onError={setError} zoom={zoom} setZoom={setZoom} apply={apply} scrollRef={scrollRef} selZoom={selZoom} setSelZoom={setSelZoom} onDraft={setDragModel} />
        </div>
      </div>

      {help && (
        <div role="dialog" aria-label="Kısayollar" onClick={() => setHelp(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 10, padding: 22, width: 560, maxWidth: "92vw" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><b>Klavye kısayolları</b><button className="icon" aria-label="Kapat" onClick={() => setHelp(false)}><i className="icon-x" /></button></div>
            {SHORTCUTS.map(([k, d]) => <div key={k} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 10, padding: "4px 0", fontSize: 13 }}><span className="mono" style={{ color: "var(--accent)" }}>{k}</span><span className="t2">{d}</span></div>)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Kamera hareketleri: çıkış zaman çizelgesindeki punch-in/zoom listesi (work/assemble.json → zooms). */
function ZoomPanel({ zooms, selZoom, setSelZoom, playhead, setPlayhead, apply, onAdd, canAdd }) {
  const field = (zm, key, label, step, unit, min, max) => (
    <label key={`${zm.id}${key}${zm[key]}`} className="col" style={{ gap: 2 }}>
      <span className="t3" style={{ fontSize: 10 }}>{label}</span>
      <input className="field mono" type="number" step={step} min={min} max={max} defaultValue={Number(zm[key].toFixed(3))} aria-label={`${label} (${zm.id})`} title={unit}
        onBlur={(e) => { const v = Number(e.target.value); const ok = e.target.value !== "" && Number.isFinite(v) && Math.abs(v - zm[key]) > 1e-6 && apply((m) => setZoomMove(m, zm.id, { [key]: v })); if (!ok) e.target.value = Number(zm[key].toFixed(3)); }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
    </label>
  );
  return (
    <div className="col" style={{ gap: 8, borderTop: "1px solid var(--b1)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <b style={{ fontSize: 13 }}>Kamera (zoom)</b>
        <button className="btn sm" disabled={!canAdd} onClick={onAdd} title="Oynatma kafasına 2 sn'lik zoom (Z)"><i className="icon-plus" />Ekle</button>
      </div>
      {!zooms.length && <span className="t3 s12" style={{ lineHeight: 1.5 }}>Konuşan kafaya punch-in. Oynatma kafasını koy, Z'ye bas. Önizleme birleştirmeyle aynı kırpmayı gösterir.</span>}
      {zooms.map((zm) => {
        const active = selZoom === zm.id || (playhead >= zm.from && playhead <= zm.to);
        return (
          <div key={zm.id} data-testid={`zoom-${zm.id}`} onPointerDown={() => setSelZoom(zm.id)} style={{ border: `1px solid ${active ? "var(--accent)" : "var(--b1)"}`, borderRadius: 6, padding: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button className="tm-tb" style={{ width: "auto", padding: "0 6px" }} onClick={() => setPlayhead(zm.from)} title="Oynatma kafasını başına götür"><span className="mono" style={{ fontSize: 11 }}>{zm.from.toFixed(2)}–{zm.to.toFixed(2)} sn · {zm.z.toFixed(2)}×</span></button>
              <button className="tm-tb" aria-label={`${zm.id} sil`} title="Zoom'u sil" onClick={() => apply((m) => removeZoomMove(m, zm.id))}><i className="icon-trash-2" /></button>
            </div>
            {field(zm, "from", "Başlangıç", 0.1, "sn", 0)}
            {field(zm, "to", "Bitiş", 0.1, "sn", 0)}
            {field(zm, "z", "Ölçek", 0.01, `×${ZOOM_MIN}–${ZOOM_MAX}`, ZOOM_MIN, ZOOM_MAX)}
            {field(zm, "cx", "Yatay odak", 0.05, "0 sol – 1 sağ", 0, 1)}
            {field(zm, "cy", "Dikey odak", 0.05, "0 üst – 1 alt", 0, 1)}
            {field(zm, "in", "Giriş rampası", 0.1, "sn (0 = kesmede sert)", 0)}
            {field(zm, "out", "Çıkış rampası", 0.1, "sn", 0)}
          </div>
        );
      })}
    </div>
  );
}

/** Seçili klibin sayısal alanları; boş bırakılan/geçersiz değer işlenmez. */
function Props({ clip, fps, apply, file }) {
  const num = (label, value, onSet, step = 0.1, unit = "sn") => (
    <label className="col" style={{ gap: 4 }}>
      <span className="t3 s12">{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input className="field mono" type="number" step={step} defaultValue={Number(value.toFixed(3))} aria-label={label}
          onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && Math.abs(v - value) > 1e-6) apply((m) => onSet(m, v)); }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <span className="t3 s12">{unit}</span>
      </div>
    </label>
  );
  return (
    <div className="col" style={{ gap: 10 }}>
      <div style={{ fontSize: 12, wordBreak: "break-all" }} title={clip.src}>{clip.label}</div>
      <span className="mono t3" style={{ fontSize: 10 }}>{clip.kind.toUpperCase()} · {timecode(clip.start, fps)} → {timecode(end(clip), fps)} · {dur(clip).toFixed(2)} sn</span>
      {num("Başlangıç (çizelge)", clip.start, (m, v) => setClip(m, clip.id, { start: v }))}
      {num("Kaynak girişi", clip.srcIn, (m, v) => setClip(m, clip.id, { srcIn: Math.min(Math.max(0, v), clip.srcOut - 0.1) }))}
      {num("Kaynak çıkışı", clip.srcOut, (m, v) => setClip(m, clip.id, { srcOut: Math.max(clip.srcIn + 0.1, Math.min(v, clip.srcMax ?? v)) }))}
      {num("Ses seviyesi", clip.gainDb ?? 0, (m, v) => setClip(m, clip.id, { gainDb: Math.max(-24, Math.min(12, v)) }), 0.5, "dB")}
      {file && <span className="t3" style={{ fontSize: 11 }}>Kaynak: {fmt(file.duration)} · {file.name}</span>}
    </div>
  );
}
