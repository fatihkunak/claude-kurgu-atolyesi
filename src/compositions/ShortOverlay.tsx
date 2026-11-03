// Vertical Shorts overlay (1080×1920, transparent): a title block above the 16:9 picture, word-by-word
// captions below it and a closing call-to-action. The picture itself (the finished long-form master, letterboxed
// over its own blurred copy) is assembled by scripts/90-shorts.mjs; only this thin layer is rendered here.
import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { color, font } from "../theme/theme";

export type ShortProps = {
  kicker: string;
  title: string;
  titleAccent: string;
  captions: { from: number; to: number; text: string }[]; // seconds
  cta: { at: number; text: string; sub: string };
  durationSeconds: number;
  fps: number;
  locale: "tr" | "en";
  layout?: "letterbox" | "portrait"; // portrait: the presenter fills 1080×1440 (3:4 crop that follows the face), title band above
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const pop = Easing.bezier(0.34, 1.56, 0.64, 1);
const geometry = (layout?: string) => (layout === "portrait" ? { top: 300, height: 1440 } : { top: 656, height: 608 }); // letterbox: 16:9 picture 1080×608 centred

export const ShortOverlay: React.FC<ShortProps> = ({ kicker, title, titleAccent, captions, cta, locale, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const portrait = layout === "portrait";
  const PIC_TOP = geometry(layout).top, PIC_BOTTOM = PIC_TOP + geometry(layout).height;
  const up = (s: string) => s.toLocaleUpperCase(locale === "en" ? "en-US" : "tr-TR");
  const inTitle = interpolate(frame, [0, 0.45 * fps], [0, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const cur = t < cta.at ? captions.find((c) => t >= c.from && t < c.to) : undefined; // the card takes the captions' place
  const ctaP = interpolate(t, [cta.at, cta.at + 0.5], [0, 1], { ...clamp, easing: pop });
  return (
    <AbsoluteFill style={{ fontFamily: font.display, color: color.text }}>
      {/* title block above the picture */}
      <div style={{ position: "absolute", top: portrait ? 70 : 250, left: 60, right: 60, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: inTitle, translate: `0px ${(1 - inTitle) * -30}px` }}>
        <div style={{ fontFamily: font.text, fontWeight: 800, fontSize: 34, letterSpacing: 6, color: color.accent }}>{up(kicker)}</div>
        <div style={{ textAlign: "center", fontWeight: 800, fontSize: 72, lineHeight: 1.02, letterSpacing: -1.2, textShadow: "0 6px 24px rgba(0,0,0,0.6)" }}>{title}</div>
        <div style={{ textAlign: "center", fontWeight: 800, fontSize: 124, lineHeight: 0.95, letterSpacing: -3, whiteSpace: "nowrap", color: color.accent, textShadow: "0 8px 30px rgba(0,0,0,0.6)" }}>{titleAccent}</div>
      </div>
      {/* word-by-word captions below the picture */}
      <div style={{ position: "absolute", top: portrait ? PIC_BOTTOM - 330 : PIC_BOTTOM + 70, left: 50, right: 50, display: "flex", justifyContent: "center" }}>
        {cur ? (
          <div key={cur.from} style={{ padding: "14px 30px 18px", borderRadius: 22, background: color.ink, fontWeight: 800, fontSize: 70, lineHeight: 1.05, textAlign: "center", letterSpacing: -1,
            scale: String(interpolate(t, [cur.from, cur.from + 0.18], [0.86, 1], { ...clamp, easing: pop })), boxShadow: "0 16px 40px rgba(0,0,0,0.45)" }}>
            {up(cur.text)}
          </div>
        ) : null}
      </div>
      {/* closing call to action: below the picture, so the presenter's face stays visible */}
      {ctaP > 0 ? (
        <div style={{ position: "absolute", top: portrait ? PIC_BOTTOM - 380 : PIC_BOTTOM + 60, left: 70, right: 70, display: "flex", flexDirection: "column", alignItems: "center", gap: 18, opacity: interpolate(ctaP, [0, 0.3], [0, 1], clamp) }}>
          <div style={{ padding: "26px 40px 30px", borderRadius: 30, background: color.accent, color: color.accentInk, textAlign: "center", scale: String(0.85 + 0.15 * ctaP), boxShadow: "0 24px 60px rgba(0,0,0,0.5)" }}>
            <div style={{ fontWeight: 800, fontSize: 76, lineHeight: 1.02, letterSpacing: -1.5 }}>{cta.text}</div>
            <div style={{ fontFamily: font.text, fontWeight: 800, fontSize: 36, marginTop: 10 }}>{cta.sub}</div>
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
