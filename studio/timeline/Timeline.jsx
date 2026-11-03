// Montaj timeline görünümü. Mantık engine.mjs'te; burada yalnız çizim + işaretçi hareketleri.
// Sürükleme sırasında model "taslak" olarak tutulur (geri al kaydı oluşmaz), bırakınca tek işlem olarak işlenir.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SNAP_PX, clipsInRect, dragZoom, dur, end, moveClips, pxPerSec, setTrack, zoomLanes, tickStep, timeToX, timecode, totalDuration, trimClip, xToTime,
} from "./engine.mjs";

export const LABEL_W = 148;
const ROW_H = { video: 64, audio: 44 };
const HANDLE = 7;
const COLORS = { hlg: "#3b6e8f", sdr: "#7a5aa6", audio: "#4d7a52" };

const css = `
.tm{display:flex;flex-direction:column;min-height:0;height:100%;background:var(--bg);user-select:none}
.tm-scroll{flex:1;min-height:0;overflow:auto;position:relative;background:var(--well)}
.tm-ruler{position:sticky;top:0;z-index:5;height:26px;background:var(--s1);border-bottom:1px solid var(--b1);cursor:col-resize}
.tm-tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--b2)}
.tm-tick span{position:absolute;top:3px;left:4px;font:10px var(--mono);color:var(--t3);white-space:nowrap}
.tm-row{position:relative;border-bottom:1px solid var(--b1)}
.tm-label{position:sticky;left:0;z-index:4;width:${LABEL_W}px;height:100%;background:var(--s1);border-right:1px solid var(--b1);display:flex;align-items:center;gap:2px;padding:0 4px 0 8px;font-size:12px;color:var(--t2)}
.tm-label b{flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-tb{width:22px;height:22px;border:none;border-radius:4px;background:transparent;color:var(--t3);font-size:12px;padding:0}
.tm-tb:hover{background:var(--s3);color:var(--text)}.tm-tb.on{color:var(--accent)}
.tm-clip{position:absolute;top:4px;bottom:4px;border-radius:5px;overflow:hidden;border:1px solid rgba(255,255,255,.18);cursor:grab;box-shadow:0 1px 2px rgba(0,0,0,.4)}
.tm-clip.sel{border:2px solid var(--accent);z-index:2}
.tm-clip.locked{opacity:.55;cursor:not-allowed}
.tm-clip .strip{position:absolute;inset:0;display:flex;opacity:.85;pointer-events:none}
.tm-clip .strip img{height:100%;flex:1 1 0;min-width:0;object-fit:cover;pointer-events:none}
.tm-clip .cap{position:absolute;left:0;right:0;bottom:0;padding:1px 5px;font-size:11px;background:linear-gradient(transparent,rgba(0,0,0,.75));color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.tm-clip .h{position:absolute;top:0;bottom:0;width:${HANDLE}px;cursor:ew-resize;z-index:3}
.tm-clip .h.l{left:0}.tm-clip .h.r{right:0}
.tm-clip .h:hover{background:rgba(253,215,21,.55)}
.tm-clip .wave{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.tm-clip .wave.low{top:60%;height:34%;background:rgba(0,0,0,.35)}
.tm-zoom{position:absolute;top:5px;bottom:5px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:#8a6d1f;cursor:grab;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.4)}
.tm-zoom.sel{border:2px solid var(--accent);z-index:2}
.tm-zoom.out{background:repeating-linear-gradient(135deg,#6b5518 0 6px,#4d3d12 6px 12px);border-style:dashed}
.tm-zoom .cap{position:absolute;inset:0;display:flex;align-items:center;padding:0 9px;font-size:11px;color:#fff;white-space:nowrap;overflow:hidden;pointer-events:none}
.tm-zoom .h{position:absolute;top:0;bottom:0;width:${HANDLE}px;cursor:ew-resize;z-index:3}
.tm-zoom .h.l{left:0}.tm-zoom .h.r{right:0}
.tm-zoom .h:hover{background:rgba(253,215,21,.55)}
.tm-head{position:absolute;top:0;bottom:0;width:0;border-left:1px solid var(--accent);z-index:6;pointer-events:none}
.tm-head::before{content:"";position:absolute;top:0;left:-6px;border:6px solid transparent;border-top-color:var(--accent)}
.tm-snap{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed #fff;z-index:6;pointer-events:none;opacity:.7}
.tm-lasso{position:absolute;border:1px solid var(--accent);background:rgba(253,215,21,.12);z-index:7;pointer-events:none}
.tm-tools{display:flex;align-items:center;gap:4px;padding:6px 10px;background:var(--s1);border-bottom:1px solid var(--b1);flex-wrap:wrap}
.tm-sep{width:1px;height:20px;background:var(--b2);margin:0 4px}
`;

// ses dosyasının tepe değerleri (sunucu: /api/montage/wave, 20 bin/sn); dosya başına bir kez çekilir
const waveCache = new Map();
const loadWave = (id) => {
  if (!waveCache.has(id)) waveCache.set(id, fetch(`/api/montage/wave?id=${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return waveCache.get(id);
};
/** Klibin kullandığı kaynak aralığının dalga formu: her ~2 px'e bir sütun, sütunun tepe değeri. */
export function Wave({ fileId, srcIn, srcOut, width, low }) {
  const [w, setW] = useState(null);
  useEffect(() => { let live = true; loadWave(fileId).then((x) => { if (live) setW(x); }); return () => { live = false; }; }, [fileId]);
  if (!w) return null;
  const cols = Math.max(8, Math.min(800, Math.round(width / 2)));
  const a = srcIn * w.perSec, per = ((srcOut - srcIn) * w.perSec) / cols;
  let d = "";
  for (let i = 0; i < cols; i++) {
    const s0 = Math.floor(a + i * per), s1 = Math.max(s0 + 1, Math.ceil(a + (i + 1) * per));
    let m = 0;
    for (let k = s0; k < s1 && k < w.peaks.length; k++) if (w.peaks[k] > m) m = w.peaks[k];
    const h = Math.max(2, m);
    d += `M${i} ${50 - h / 2}V${50 + h / 2}`;
  }
  return (
    <svg className={`wave${low ? " low" : ""}`} viewBox={`0 0 ${cols} 100`} preserveAspectRatio="none" aria-hidden>
      <path d={d} stroke="rgba(255,255,255,.8)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" fill="none" />
    </svg>
  );
}

export function Timeline({ model, commit, playhead, setPlayhead, selected, setSelected, thumbsOk, snapOn, onError, zoom, setZoom, apply, scrollRef, selZoom, setSelZoom, onDraft }) {
  const [draft, setDraft] = useState(null); // sürükleme sırasındaki geçici model
  useEffect(() => { onDraft?.(draft); }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  const [lasso, setLasso] = useState(null);
  const [snapLine, setSnapLine] = useState(null);
  const view = draft ?? model;
  const pps = pxPerSec(zoom);
  const width = Math.max(timeToX(totalDuration(view) + 20, zoom), 900);
  const innerRef = useRef(null);
  const live = useRef({});
  live.current = { model, view, playhead, snapOn, zoom, selected };

  // Ctrl+tekerlek: imleç altındaki zamanı sabit tutarak yakınlaştırır
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left + el.scrollLeft - LABEL_W;
      const t = xToTime(x, live.current.zoom);
      const z = Math.min(14, Math.max(-6, live.current.zoom + (e.deltaY < 0 ? 1 : -1)));
      setZoom(z);
      requestAnimationFrame(() => { el.scrollLeft = timeToX(t, z) - (e.clientX - rect.left - LABEL_W); });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef, setZoom]);

  const xOf = (e) => e.clientX - innerRef.current.getBoundingClientRect().left - LABEL_W;
  const snapCfg = () => (live.current.snapOn ? { threshold: SNAP_PX / pxPerSec(live.current.zoom), playhead: live.current.playhead } : undefined);

  const rowTops = useMemo(() => {
    let y = 26;
    return view.tracks.map((t) => { const top = y; y += ROW_H[t.kind]; return { id: t.id, top, h: ROW_H[t.kind], kind: t.kind }; });
  }, [view.tracks]);
  const trackAtY = (y) => rowTops.find((r) => y >= r.top && y < r.top + r.h);

  const watch = (onMove, onUp) => {
    const move = (e) => onMove(e);
    const up = (e) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onUp(e); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const rulerDown = (e) => {
    const seek = (ev) => setPlayhead(Math.max(0, Math.round(xToTime(xOf(ev), live.current.zoom) * model.fps) / model.fps));
    seek(e);
    watch(seek, () => {});
  };

  const clipDown = (e, c, mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelZoom(null);
    const base = live.current.model;
    const track =base.tracks.find((t) => t.id === c.trackId);
    // seçim: Shift/Ctrl ekler-çıkarır; seçili olmayana basınca yalnız o seçilir
    let sel = live.current.selected;
    const shiftOrCtrl = e.shiftKey || e.ctrlKey || e.metaKey;
    if (shiftOrCtrl) {
      sel = sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id];
      setSelected(sel);
      if (!sel.includes(c.id)) return;
    } else if (!sel.includes(c.id)) { sel = [c.id]; setSelected(sel); }
    if (track.locked) { onError("İz kilitli."); return; }
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, latest = base;
    watch((m) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 3) return;
      moved = true;
      const dt = (m.clientX - x0) / pxPerSec(live.current.zoom);
      const snap = snapCfg();
      try {
        if (mode === "move") {
          const row = trackAtY(m.clientY - innerRef.current.getBoundingClientRect().top);
          const toTrack = sel.length === 1 && row && row.id !== c.trackId && row.kind === track.kind ? row.id : undefined;
          latest = moveClips(base, sel, dt, { snap, toTrack });
        } else {
          const t = mode === "left" ? c.start + dt : end(c) + dt;
          latest = trimClip(base, c.id, mode, t, { snap, srcMax: c.srcMax });
        }
        setDraft(latest);
        const moving = latest.clips.find((x) => x.id === c.id);
        const edge = mode === "right" ? end(moving) : moving.start;
        const hit = [0, live.current.playhead, ...base.clips.filter((x) => !sel.includes(x.id)).flatMap((x) => [x.start, end(x)])].find((p) => Math.abs(p - edge) < 1e-6);
        setSnapLine(snap && hit !== undefined ? hit : null);
      } catch { /* çakışma: son geçerli taslak kalır */ }
    }, () => {
      setSnapLine(null);
      setDraft(null);
      if (moved && latest !== base) commit(latest);
      // sürüklemeden bırakılan tık: çoklu seçimin içindeki klibe basmak seçimi o klibe indirir (standart NLE davranışı)
      else if (!moved && !shiftOrCtrl && sel.length > 1) setSelected([c.id]);
    });
  };

  // zoom çubuğu: gövde = taşı, kenarlar = kırp (kare ızgarasına oturur; < 0,1 sn ya da 0'ın soluna giden hareket yok sayılır)
  const zoomDown = (e, zm, mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected([]);
    setSelZoom(zm.id);
    const base = live.current.model;
    const x0 = e.clientX;
    let moved = false, latest = base;
    watch((m) => {
      if (!moved && Math.abs(m.clientX - x0) < 3) return;
      moved = true;
      const dt = (m.clientX - x0) / pxPerSec(live.current.zoom);
      try {
        const r = dragZoom(base, zm.id, mode, dt, { snap: snapCfg() });
        latest = r.model;
        setDraft(latest);
        setSnapLine(r.snapped);
      } catch { /* geçersiz: son geçerli taslak kalır */ }
    }, () => {
      setSnapLine(null);
      setDraft(null);
      if (moved && latest !== base) commit(latest);
      else if (!moved) setPlayhead(zm.from);
    });
  };

  const bgDown = (e) => {
    if (e.button !== 0 || e.target.closest(".tm-clip,.tm-zoom,.tm-label,.tm-ruler")) return;
    setSelZoom(null);
    const top = innerRef.current.getBoundingClientRect().top;
    const x0 = xOf(e), y0 = e.clientY - top;
    const additive = e.shiftKey || e.ctrlKey;
    const base = additive ? live.current.selected : [];
    if (!additive) setSelected([]);
    setPlayhead(Math.max(0, Math.round(xToTime(x0, live.current.zoom) * model.fps) / model.fps));
    watch((m) => {
      const x1 = xOf(m), y1 = m.clientY - top;
      if (Math.hypot(x1 - x0, y1 - y0) < 4) return;
      setLasso({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
      const rows = rowTops.filter((r) => r.top < Math.max(y0, y1) && r.top + r.h > Math.min(y0, y1)).map((r) => r.id);
      const hit = clipsInRect(live.current.model, xToTime(Math.min(x0, x1), live.current.zoom), xToTime(Math.max(x0, x1), live.current.zoom), rows);
      setSelected([...new Set([...base, ...hit])]);
    }, () => setLasso(null));
  };

  const step = tickStep(zoom);
  const ticks = [];
  for (let t = 0; t * pps < width; t += step) ticks.push(t);
  const fps = model.fps;

  return (
    <div className="tm">
      <style>{css}</style>
      <div className="tm-scroll" ref={scrollRef}>
        <div ref={innerRef} style={{ width: width + LABEL_W, position: "relative", minHeight: "100%" }} onPointerDown={bgDown}>
          <div className="tm-ruler" style={{ marginLeft: LABEL_W, width }} onPointerDown={(e) => { e.stopPropagation(); rulerDown(e); }}>
            {ticks.map((t) => <div key={t} className="tm-tick" style={{ left: timeToX(t, zoom) }}><span>{timecode(t, fps)}</span></div>)}
          </div>
          {view.tracks.map((tr) => (
            <div key={tr.id} className="tm-row" style={{ height: ROW_H[tr.kind], opacity: tr.hidden ? 0.45 : 1, background: tr.locked ? "repeating-linear-gradient(135deg,transparent 0 8px,rgba(255,255,255,.03) 8px 16px)" : undefined }}>
              <div className="tm-label">
                <i className={tr.kind === "video" ? "icon-film" : "icon-audio-lines"} style={{ fontSize: 13 }} />
                <b title={tr.label}>{tr.label}</b>
                <button className={`tm-tb${tr.locked ? " on" : ""}`} title={tr.locked ? "Kilidi aç" : "Kilitle"} aria-label={`${tr.label} kilidi`} onClick={() => apply((m) => m && setTrack(m, tr.id, { locked: !tr.locked }))}><i className={tr.locked ? "icon-lock" : "icon-lock-open"} /></button>
                <button className={`tm-tb${tr.hidden ? " on" : ""}`} title={tr.hidden ? "Göster" : "Gizle"} aria-label={`${tr.label} görünürlüğü`} onClick={() => apply((m) => setTrack(m, tr.id, { hidden: !tr.hidden }))}><i className={tr.hidden ? "icon-eye-off" : "icon-eye"} /></button>
                {tr.kind === "audio" && <button className={`tm-tb${tr.muted ? " on" : ""}`} title={tr.muted ? "Sesi aç" : "Sustur"} aria-label={`${tr.label} sessiz`} onClick={() => apply((m) => setTrack(m, tr.id, { muted: !tr.muted }))}><i className={tr.muted ? "icon-volume-x" : "icon-volume-2"} /></button>}
              </div>
              {view.clips.filter((c) => c.trackId === tr.id).map((c) => {
                const w = Math.max(timeToX(dur(c), zoom), 4), n = Math.min(8, Math.max(1, Math.floor(w / 96)));
                const isSel = selected.includes(c.id);
                return (
                  <div key={c.id} className={`tm-clip${isSel ? " sel" : ""}${tr.locked ? " locked" : ""}`} data-clip={c.id}
                    style={{ left: LABEL_W + timeToX(c.start, zoom), width: w, background: tr.kind === "audio" ? COLORS.audio : COLORS[c.kind] }}
                    onPointerDown={(e) => clipDown(e, c, "move")} title={`${c.label} · ${timecode(c.start, fps)} → ${timecode(end(c), fps)}`}>
                    {tr.kind === "video" && thumbsOk && c.fileId && (
                      <div className="strip">
                        {Array.from({ length: n }, (_, i) => (
                          <img key={i} alt="" loading="lazy" draggable={false}
                            src={`/api/montage/thumb?id=${c.fileId}&t=${(c.srcIn + (dur(c) * (i + 0.5)) / n).toFixed(1)}&w=160`} />
                        ))}
                      </div>
                    )}
                    {tr.kind === "audio" && c.fileId && <Wave fileId={c.fileId} srcIn={c.srcIn} srcOut={c.srcOut} width={w} />}
                    {tr.kind === "video" && c.fileId && c.hasAudio && <Wave low fileId={c.fileId} srcIn={c.srcIn} srcOut={c.srcOut} width={w} />}
                    <div className="cap">{c.label}{c.groupId ? " ⛓" : ""} · {dur(c).toFixed(1)} sn{c.gainDb ? ` · ${c.gainDb > 0 ? "+" : ""}${c.gainDb} dB` : ""}</div>
                    <div className="h l" onPointerDown={(e) => clipDown(e, c, "left")} />
                    <div className="h r" onPointerDown={(e) => clipDown(e, c, "right")} />
                  </div>
                );
              })}
            </div>
          ))}
          {(() => {
            const zs = view.zooms ?? [], { lane, count } = zoomLanes(zs), total = totalDuration(view);
            return (
              <div className="tm-row" style={{ height: 8 + count * 26 }} data-testid="zoom-row">
                <div className="tm-label"><i className="icon-zoom-in" style={{ fontSize: 13 }} /><b>Kamera</b></div>
                {zs.map((zm) => {
                  const outside = zm.from >= total - 1e-6; // çıkış süresinin dışında: Birleştir'de atılır
                  return (
                    <div key={zm.id} className={`tm-zoom${selZoom === zm.id ? " sel" : ""}${outside ? " out" : ""}`} data-zoom={zm.id}
                      style={{
                        left: LABEL_W + timeToX(zm.from, zoom), width: Math.max(timeToX(zm.to - zm.from, zoom), 6), top: 4 + lane[zm.id] * 26, bottom: "auto", height: 22,
                        // giriş/çıkış rampaları koyu geçişle gösterilir (ölçek o kısımda 1×'ten tam değere çıkar/iner)
                        ...(outside ? {} : { backgroundImage: `linear-gradient(90deg, rgba(0,0,0,.5) 0, rgba(0,0,0,0) ${timeToX(zm.in, zoom)}px, rgba(0,0,0,0) calc(100% - ${timeToX(zm.out, zoom)}px), rgba(0,0,0,.5) 100%)` }),
                      }}
                      onPointerDown={(e) => zoomDown(e, zm, "move")}
                      title={`Zoom ${zm.z.toFixed(2)}× · ${timecode(zm.from, fps)} → ${timecode(zm.to, fps)}${outside ? " · videonun dışında, Birleştir'de atılır" : zm.to > total + 1e-6 ? " · sonu video süresinde kırpılır" : ""}`}>
                      <div className="cap">{zm.z.toFixed(2)}×{outside ? " (dışarıda)" : ""}</div>
                      <div className="h l" onPointerDown={(e) => zoomDown(e, zm, "left")} />
                      <div className="h r" onPointerDown={(e) => zoomDown(e, zm, "right")} />
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {snapLine != null && <div className="tm-snap" style={{ left: LABEL_W + timeToX(snapLine, zoom) }} />}
          <div className="tm-head" style={{ left: LABEL_W + timeToX(playhead, zoom) }} />
          {lasso && <div className="tm-lasso" style={{ left: LABEL_W + lasso.x, top: lasso.y, width: lasso.w, height: lasso.h }} />}
        </div>
      </div>
    </div>
  );
}

