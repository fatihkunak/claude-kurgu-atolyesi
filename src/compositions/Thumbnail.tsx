// YouTube thumbnail (1280×720): a frame of the video full-bleed, the title on a flat opaque panel in the brand colours.
// No glow, outline or gradient (marka/MARKA.md §3); the title comes from the speaker's own words (scripts/95-thumbnail.mjs).
import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { color, font } from "../theme/theme";

export type ThumbnailProps = {
  title: string;
  accent: string; // words of the title shown in the accent colour (comma-free, space separated)
  frame: string; // path under public/
  locale: "tr" | "en";
};

export const Thumbnail: React.FC<ThumbnailProps> = ({ title, accent, frame, locale }) => {
  const up = (s: string) => s.toLocaleUpperCase(locale === "en" ? "en-US" : "tr-TR");
  const accented = new Set(up(accent).split(/\s+/).filter(Boolean));
  const words = up(title).split(/\s+/).filter(Boolean);
  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Img src={staticFile(frame)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <div style={{ position: "absolute", left: 48, bottom: 48, maxWidth: 760, background: color.ink, padding: "26px 36px 30px" }}>
        <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 118, lineHeight: 0.95, letterSpacing: -2, color: color.text }}>
          {words.map((w, i) => (
            <span key={i} style={{ color: accented.has(w) ? color.accent : color.text }}>{w}{i < words.length - 1 ? " " : ""}</span>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
