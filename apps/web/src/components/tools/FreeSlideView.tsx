// Read-only renderer for a freeform slide: lays out its absolutely-positioned
// elements in the 1280x720 design space (the parent scales the whole thing).
// Shared by the hands-on editor canvas, the deck viewer, and thumbnails.
import type { CSSProperties } from "react";
import { API_BASE } from "@/lib/use-api";
import type { FreeElement, FreeSlide } from "@/lib/slide-free";
import { SLIDE_H, SLIDE_W } from "@/lib/slide-types";

export function elementImageSrc(el: Extract<FreeElement, { type: "image" }>): string | undefined {
  if (el.src) return el.src;
  return el.artifactId ? `${API_BASE}/api/artifacts/${el.artifactId}/blob` : undefined;
}

export function positionStyle(el: FreeElement): CSSProperties {
  return {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    zIndex: el.z,
  };
}

/** The inner content of an element (no positioning — the caller positions it). */
export function FreeElementContent({ el }: { el: FreeElement }) {
  if (el.type === "text") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          fontFamily: el.fontFamily,
          fontSize: el.fontSize,
          fontWeight: el.fontWeight,
          color: el.color,
          textAlign: el.align,
          fontStyle: el.italic ? "italic" : "normal",
          lineHeight: el.lineHeight ?? 1.3,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "hidden",
        }}
      >
        {el.text}
      </div>
    );
  }
  if (el.type === "shape") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: el.fill,
          borderRadius: el.shape === "ellipse" ? "50%" : (el.radius ?? 0),
        }}
      />
    );
  }
  const src = elementImageSrc(el);
  return src ? (
    <img
      src={src}
      alt=""
      draggable={false}
      style={{
        width: "100%",
        height: "100%",
        objectFit: el.fit,
        borderRadius: el.radius ?? 0,
        display: "block",
      }}
    />
  ) : (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "rgba(127,127,127,.15)",
        borderRadius: el.radius ?? 0,
      }}
    />
  );
}

/** A full freeform slide at design size (1280x720). Parent applies scale. */
export function FreeSlideView({ slide, style }: { slide: FreeSlide; style?: CSSProperties }) {
  const els = [...slide.elements].sort((a, b) => a.z - b.z);
  return (
    <div
      style={{
        position: "relative",
        width: SLIDE_W,
        height: SLIDE_H,
        background: slide.background,
        overflow: "hidden",
        ...style,
      }}
    >
      {els.map((el) => (
        <div key={el.id} style={positionStyle(el)}>
          <FreeElementContent el={el} />
        </div>
      ))}
    </div>
  );
}
