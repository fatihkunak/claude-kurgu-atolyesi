// "Gizlilik" aşaması: yüz bulanıklığı. Akış: Tara (yüzleri bul) → İzleri çıkar → izleri gözden geçir (yanlış olanları kapat: heykel, duvar resmi, maske)
// → elle kutu ekle (plaka, tabela) → Maskeyi üret → "Birleştirmede uygula". Sunucu: studio/privacy.mjs (scripts/85-privacy.mjs'i çalıştırır).
import { useCallback, useEffect, useRef, useState } from "react";

const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `Hata ${r.status}`);
  return data;
};
const when = (ms) => (ms ? new Date(ms).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "yok");
const tc = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const STEP_NAMES = { detect: "Tarama", review: "İzler", mask: "Maske" };

export function PrivacyStage({ setError }) {
  const [s, setS] = useState(null);
  const [skip, setSkip] = useState(new Set());
  const [onlyOff, setOnlyOff] = useState(false);
  const [boxes, setBoxes] = useState([]);
  const [t, setT] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  const [draw, setDraw] = useState(null);
  const imgRef = useRef(null);
  const loaded = useRef(false);
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    const x = await (await fetch("/api/privacy")).json();
    setS(x);
    if (!loaded.current) { loaded.current = true; setSkip(new Set(x.tracks.filter((q) => q.skip).map((q) => q.id))); setBoxes(x.manual); }
    return x;
  }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load, setError]);
  useEffect(() => {
    if (s?.job.state !== "running") return undefined;
    const id = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(id);
  }, [s?.job.state, load]);

  const guard = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } };
  const run = (step) => guard(() => post("/api/privacy/run", { step }));
  const toggle = (id) => {
    const next = new Set(skip);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSkip(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => guard(() => post("/api/privacy/skip", { ids: [...next] })), 500);
  };
  const saveBoxes = (list) => { setBoxes(list); guard(() => post("/api/privacy/manual", { boxes: list })); };

  if (!s) return <div className="mono t2" style={{ padding: 28 }}>Yükleniyor…</div>;
  const running = s.job.state === "running";
  const sw = s.source.width, sh = s.source.height;
  const shown = onlyOff ? s.tracks.filter((q) => skip.has(q.id)) : s.tracks;

  const rect = (e) => { const r = imgRef.current.getBoundingClientRect(); return [Math.max(0, Math.min(r.width, e.clientX - r.left)), Math.max(0, Math.min(r.height, e.clientY - r.top)), r]; };
  const down = (e) => {
    const [x0, y0] = rect(e);
    setDraw({ x0, y0, x1: x0, y1: y0 });
    const move = (m) => { const [x1, y1] = rect(m); setDraw({ x0, y0, x1, y1 }); };
    const up = (m) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const [x1, y1, r] = rect(m);
      setDraw(null);
      const k = sw / r.width; // ekran px → kaynak px
      const w = Math.abs(x1 - x0) * k, h = Math.abs(y1 - y0) * k;
      if (w < 8 || h < 8) return;
      saveBoxes([...boxes, { start: Number(t.toFixed(2)), end: Number((t + 2).toFixed(2)), x: Math.min(x0, x1) * k, y: Math.min(y0, y1) * k, w, h, shape: "box" }]);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  return (
    <div className="page">
      <div className="col" style={{ maxWidth: 980, margin: "0 auto", padding: "32px 40px 80px", gap: 22 }}>
        <div className="col" style={{ gap: 6 }}>
          <h1 className="h1">Gizlilik</h1>
          <span className="t2" style={{ lineHeight: 1.5 }}>Yoldan geçenlerin yüzlerini bulanıklaştırır. Heykel, duvar resmi ve maske gibi yanlış bulunanları kapat; plaka ve tabelaları elle kutuyla ekle. Maske yalnız “Birleştirmede uygula” açıkken teslim videoya girer.</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
          {[["detect", "1 · Tara", "Yüzleri bul (uzun sürer: ~6 dk 4K için ~35 dk)", s.files.raw], ["review", "2 · İzleri çıkar", "Yüzleri izlere bağla, kontak sayfası", s.files.proposals], ["mask", "3 · Maske", "Onaylanan izler + elle kutulardan maske videosu", s.files.mask]].map(([step, title, sub, at]) => (
            <div key={step} className="col" style={{ background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 8, padding: 12, gap: 6 }}>
              <b>{title}</b>
              <span className="t3 s12" style={{ minHeight: 32 }}>{sub}</span>
              <span className="mono t3" style={{ fontSize: 11 }}>Son: {when(at)}</span>
              <button className="btn sm" disabled={running || (step !== "detect" && !s.files.raw)} onClick={() => run(step)}>{running && s.job.step === step ? "Çalışıyor…" : at ? "Yeniden çalıştır" : "Çalıştır"}</button>
            </div>
          ))}
        </div>
        {running && <div className="mono t2 s12" style={{ lineHeight: 1.6 }}>{STEP_NAMES[s.job.step]} sürüyor…{(s.job.log ?? []).map((l, i) => <div key={i} className="t3" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.slice(-110)}</div>)}</div>}
        {s.job.state === "failed" && <div className="s12" style={{ color: "var(--neg)" }}>{s.job.error}</div>}

        <div style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--s2)", border: `1px solid ${s.project.enabled ? "var(--accent)" : "var(--b2)"}`, borderRadius: 8, padding: "10px 14px" }}>
          <div className="col" style={{ flex: 1, gap: 2 }}>
            <b>Birleştirmede uygula</b>
            <span className="t3 s12">{s.project.enabled ? "Açık: sonraki birleştirme maskeyi uygular (yeniden render gerekir)." : s.files.mask ? "Kapalı: teslim video bulanıklaştırılmaz." : "Önce maskeyi üret."}</span>
          </div>
          <button className={`btn${s.project.enabled ? " y" : ""}`} disabled={!s.files.mask && !s.project.enabled} onClick={() => guard(() => post("/api/privacy/enable", { on: !s.project.enabled }))}>{s.project.enabled ? "Açık" : "Kapalı"}</button>
        </div>

        <div className="col" style={{ gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Yüz izleri</h2>
            <span className="t3 s12">{s.tracks.length} iz ({s.total} bulunanın {s.approved.minSizePx} px ve üstü) · {skip.size} tanesi bulanıklaştırılmayacak</span>
            <span style={{ flex: 1 }} />
            <label className="s12 t2" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={onlyOff} onChange={(e) => setOnlyOff(e.target.checked)} />Yalnız kapatılanlar</label>
            <label className="s12 t2" style={{ display: "flex", gap: 6, alignItems: "center" }}>En küçük yüz
              <input className="field mono" style={{ width: 64 }} type="number" min={10} max={400} defaultValue={s.approved.minSizePx} aria-label="En küçük yüz (px)" onBlur={(e) => guard(() => post("/api/privacy/threshold", { minSizePx: Number(e.target.value), minScore: s.approved.minScore }))} />px
            </label>
          </div>
          {!s.tracks.length && <span className="t3 s12">Henüz iz yok. Önce Tara, sonra İzleri çıkar.</span>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 8 }}>
            {shown.map((q) => {
              const off = skip.has(q.id);
              return (
                <button key={q.id} onClick={() => toggle(q.id)} aria-pressed={!off} title={off ? "Bulanıklaştırılmayacak (tıkla: aç)" : "Bulanıklaştırılacak (tıkla: kapat)"}
                  style={{ position: "relative", padding: 0, border: `2px solid ${off ? "var(--b2)" : "var(--accent)"}`, borderRadius: 8, background: "var(--s2)", overflow: "hidden", textAlign: "left" }}>
                  <img alt={`${q.id} yüz kırpması`} loading="lazy" src={`/api/privacy/crop?id=${q.id}`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block", opacity: off ? 0.35 : 1, filter: off ? "none" : "blur(0)" }} />
                  <div className="mono" style={{ fontSize: 10, padding: "3px 6px", display: "flex", justifyContent: "space-between", color: off ? "var(--t3)" : "var(--text)" }}><span>{q.id} · {tc(q.start)}</span><span>{off ? "AÇIK" : "BULANIK"}</span></div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="col" style={{ gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Elle kutular (plaka, tabela)</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label className="s12 t2" style={{ display: "flex", gap: 6, alignItems: "center" }}>Zaman
              <input className="field mono" style={{ width: 90 }} type="number" step={0.5} min={0} max={s.source.duration || undefined} value={t} onChange={(e) => setT(Math.max(0, Number(e.target.value) || 0))} aria-label="Kare zamanı (sn)" />sn
            </label>
            <button className="btn sm" onClick={() => setFrameKey((k) => k + 1)}>Kareyi getir</button>
            <span className="t3 s12">Karenin üzerinde sürükleyerek kutu çiz; süre varsayılan 2 sn, aşağıdan değiştir.</span>
          </div>
          {frameKey > 0 && (
            <div style={{ position: "relative", width: 960, maxWidth: "100%", cursor: "crosshair", touchAction: "none" }} onPointerDown={down}>
              <img ref={imgRef} key={frameKey} alt={`${t} sn karesi`} draggable={false} src={`/api/privacy/frame?t=${t}`} style={{ width: "100%", display: "block", borderRadius: 6 }} />
              {boxes.filter((b) => t >= b.start && t <= b.end).map((b, i) => (
                <div key={i} style={{ position: "absolute", left: `${(b.x / sw) * 100}%`, top: `${(b.y / sh) * 100}%`, width: `${(b.w / sw) * 100}%`, height: `${(b.h / sh) * 100}%`, border: "2px solid var(--accent)", background: "rgba(253,215,21,.18)", borderRadius: b.shape === "ellipse" ? "50%" : 2, pointerEvents: "none" }} />
              ))}
              {draw && <div style={{ position: "absolute", left: Math.min(draw.x0, draw.x1), top: Math.min(draw.y0, draw.y1), width: Math.abs(draw.x1 - draw.x0), height: Math.abs(draw.y1 - draw.y0), border: "2px dashed #fff", pointerEvents: "none" }} />}
            </div>
          )}
          {boxes.map((b, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 80px 80px 110px auto 1fr auto", gap: 8, alignItems: "center", background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 6, padding: "6px 10px" }}>
              <span className="mono t3" style={{ fontSize: 11 }}>#{i + 1}</span>
              {["start", "end"].map((k) => (
                <input key={k} className="field mono" type="number" step={0.5} min={0} defaultValue={b[k]} aria-label={`Kutu ${i + 1} ${k === "start" ? "başlangıç" : "bitiş"} (sn)`}
                  onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== b[k]) saveBoxes(boxes.map((x, j) => (j === i ? { ...x, [k]: v } : x))); }} />
              ))}
              <select className="field" value={b.shape ?? "box"} aria-label={`Kutu ${i + 1} şekli`} onChange={(e) => saveBoxes(boxes.map((x, j) => (j === i ? { ...x, shape: e.target.value } : x)))}><option value="box">Dikdörtgen</option><option value="ellipse">Elips</option></select>
              <button className="btn sm" onClick={() => { setT(b.start); setFrameKey((k) => k + 1); }}>Göster</button>
              <span className="mono t3" style={{ fontSize: 11 }}>{Math.round(b.w)}×{Math.round(b.h)} @ {Math.round(b.x)},{Math.round(b.y)}</span>
              <button className="icon" title="Kutuyu sil" aria-label={`Kutu ${i + 1} sil`} onClick={() => saveBoxes(boxes.filter((_, j) => j !== i))}><i className="icon-trash-2" /></button>
            </div>
          ))}
          {!boxes.length && <span className="t3 s12">Elle kutu yok.</span>}
        </div>
      </div>
    </div>
  );
}
