// Freeform slide model + conversion — the data layer for the hands-on
// (Adobe/Canva-style) deck editor. A free slide is a flat list of absolutely
// positioned elements in the fixed 1280x720 design space (SLIDE_W x SLIDE_H);
// the editor moves / resizes / edits them directly. AI still generates the
// structured archetype deck; `slideToFree` "explodes" each archetype into
// editable elements when the user opens the canvas editor.
import { SLIDE_H, SLIDE_W, type SlideSpec, type Theme } from "./slide-types";

export interface FreeElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  z: number;
}

export interface TextElement extends FreeElementBase {
  type: "text";
  text: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  italic?: boolean;
  lineHeight?: number;
  fontFamily?: string;
}

export interface ShapeElement extends FreeElementBase {
  type: "shape";
  shape: "rect" | "ellipse";
  fill: string;
  radius?: number;
}

export interface ImageElement extends FreeElementBase {
  type: "image";
  /** Child image artifact id; resolve via /api/artifacts/<id>/blob. */
  artifactId?: string | null;
  src?: string;
  fit: "cover" | "contain";
  radius?: number;
}

export type FreeElement = TextElement | ShapeElement | ImageElement;

export interface FreeSlide {
  archetype: "free";
  background: string;
  elements: FreeElement[];
  notes?: string;
}

export interface FreeDeck {
  theme: Theme;
  slides: FreeSlide[];
}

export function isFreeSlide(s: { archetype: string }): s is FreeSlide {
  return s.archetype === "free";
}

let idCounter = 0;
export function elId(): string {
  idCounter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : String(idCounter);
  return `el_${rand}_${idCounter}`;
}

const MARGIN = 80;
const CONTENT_W = SLIDE_W - MARGIN * 2;

// ─── Element factories ──────────────────────────────────────────────

export function newText(theme: Theme, over: Partial<TextElement> = {}): TextElement {
  return {
    id: elId(),
    type: "text",
    x: over.x ?? SLIDE_W / 2 - 220,
    y: over.y ?? SLIDE_H / 2 - 40,
    w: over.w ?? 440,
    h: over.h ?? 80,
    z: over.z ?? 0,
    text: over.text ?? "Text",
    fontSize: over.fontSize ?? 32,
    fontWeight: over.fontWeight ?? 500,
    color: over.color ?? theme.text,
    align: over.align ?? "left",
    fontFamily: over.fontFamily ?? theme.fontBody,
    italic: over.italic,
    lineHeight: over.lineHeight ?? 1.3,
  };
}

export function newShape(theme: Theme, over: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: elId(),
    type: "shape",
    x: over.x ?? SLIDE_W / 2 - 160,
    y: over.y ?? SLIDE_H / 2 - 100,
    w: over.w ?? 320,
    h: over.h ?? 200,
    z: over.z ?? 0,
    shape: over.shape ?? "rect",
    fill: over.fill ?? theme.surface,
    radius: over.radius ?? 16,
  };
}

export function newImage(over: Partial<ImageElement> = {}): ImageElement {
  return {
    id: elId(),
    type: "image",
    x: over.x ?? SLIDE_W / 2 - 240,
    y: over.y ?? SLIDE_H / 2 - 160,
    w: over.w ?? 480,
    h: over.h ?? 320,
    z: over.z ?? 0,
    artifactId: over.artifactId ?? null,
    src: over.src,
    fit: over.fit ?? "cover",
    radius: over.radius ?? 12,
  };
}

// ─── Archetype -> free conversion ───────────────────────────────────
// Each archetype becomes a small set of positioned elements that visually
// match the rendered slide, so opening the editor feels seamless.

function bulletsText(theme: Theme, bullets: string[]): string {
  return bullets.map((b) => `•  ${b}`).join("\n");
}

export function slideToFree(slide: SlideSpec, theme: Theme): FreeSlide {
  if (slide.archetype === "free") return slide as unknown as FreeSlide;

  const els: FreeElement[] = [];
  const bg = theme.bg;
  let z = 0;
  const push = (e: Omit<FreeElement, "z">) => {
    els.push({ ...e, z: z++ } as FreeElement);
  };

  switch (slide.archetype) {
    case "title": {
      if (slide.eyebrow) {
        push(
          newText(theme, {
            text: slide.eyebrow.toUpperCase(),
            x: MARGIN,
            y: 250,
            w: CONTENT_W,
            h: 40,
            fontSize: 18,
            fontWeight: 600,
            color: theme.accent,
            align: "center",
            fontFamily: theme.fontHeading,
          }),
        );
      }
      push(
        newText(theme, {
          text: slide.title,
          x: MARGIN,
          y: 288,
          w: CONTENT_W,
          h: 190,
          fontSize: 60,
          fontWeight: 800,
          color: theme.text,
          align: "center",
          fontFamily: theme.fontHeading,
          lineHeight: 1.1,
        }),
      );
      if (slide.subtitle) {
        push(
          newText(theme, {
            text: slide.subtitle,
            x: MARGIN,
            y: 492,
            w: CONTENT_W,
            h: 60,
            fontSize: 26,
            fontWeight: 400,
            color: theme.textMuted,
            align: "center",
          }),
        );
      }
      break;
    }
    case "section": {
      push(
        newText(theme, {
          text: slide.title,
          x: MARGIN,
          y: 300,
          w: CONTENT_W,
          h: 110,
          fontSize: 54,
          fontWeight: 800,
          color: theme.text,
          align: "left",
          fontFamily: theme.fontHeading,
        }),
      );
      if (slide.subtitle) {
        push(
          newText(theme, {
            text: slide.subtitle,
            x: MARGIN,
            y: 420,
            w: CONTENT_W,
            h: 60,
            fontSize: 24,
            color: theme.textMuted,
          }),
        );
      }
      break;
    }
    case "bullets": {
      push(headingEl(theme, slide.title));
      push(
        newText(theme, {
          text: bulletsText(theme, slide.bullets),
          x: MARGIN,
          y: 220,
          w: CONTENT_W,
          h: SLIDE_H - 220 - MARGIN,
          fontSize: 28,
          color: theme.text,
          lineHeight: 1.7,
        }),
      );
      break;
    }
    case "two-col": {
      push(headingEl(theme, slide.title));
      const colW = (CONTENT_W - 40) / 2;
      const cols = [slide.left, slide.right];
      cols.forEach((c, i) => {
        const cx = MARGIN + i * (colW + 40);
        if (c.heading) {
          push(
            newText(theme, {
              text: c.heading,
              x: cx,
              y: 220,
              w: colW,
              h: 44,
              fontSize: 24,
              fontWeight: 700,
              color: theme.accent,
              fontFamily: theme.fontHeading,
            }),
          );
        }
        push(
          newText(theme, {
            text: bulletsText(theme, c.points),
            x: cx,
            y: 275,
            w: colW,
            h: SLIDE_H - 275 - MARGIN,
            fontSize: 22,
            color: theme.text,
            lineHeight: 1.6,
          }),
        );
      });
      break;
    }
    case "image+text": {
      push(headingEl(theme, slide.title));
      const half = (CONTENT_W - 48) / 2;
      const imgLeft = slide.image_side === "left";
      const imgX = imgLeft ? MARGIN : MARGIN + half + 48;
      const txtX = imgLeft ? MARGIN + half + 48 : MARGIN;
      push(
        newImage({
          artifactId: slide.image_artifact_id,
          x: imgX,
          y: 220,
          w: half,
          h: SLIDE_H - 220 - MARGIN,
        }),
      );
      push(
        newText(theme, {
          text: bulletsText(theme, slide.body),
          x: txtX,
          y: 220,
          w: half,
          h: SLIDE_H - 220 - MARGIN,
          fontSize: 24,
          color: theme.text,
          lineHeight: 1.6,
        }),
      );
      break;
    }
    case "quote": {
      push(
        newText(theme, {
          text: `"${slide.quote}"`,
          x: MARGIN + 40,
          y: 240,
          w: CONTENT_W - 80,
          h: 240,
          fontSize: 44,
          fontWeight: 600,
          color: theme.text,
          align: "center",
          italic: true,
          fontFamily: theme.fontHeading,
        }),
      );
      if (slide.attribution) {
        push(
          newText(theme, {
            text: `— ${slide.attribution}`,
            x: MARGIN,
            y: 500,
            w: CONTENT_W,
            h: 44,
            fontSize: 24,
            color: theme.textMuted,
            align: "center",
          }),
        );
      }
      break;
    }
    case "chart": {
      push(headingEl(theme, slide.title));
      // Charts aren't freely editable yet; leave a labelled placeholder the
      // user can reposition or replace.
      push(
        newShape(theme, {
          x: MARGIN,
          y: 230,
          w: CONTENT_W,
          h: SLIDE_H - 230 - MARGIN,
          fill: theme.surface,
          radius: 12,
        }),
      );
      push(
        newText(theme, {
          text: slide.chart.caption ?? `${slide.chart.type} chart`,
          x: MARGIN,
          y: SLIDE_H / 2 - 20,
          w: CONTENT_W,
          h: 40,
          fontSize: 22,
          color: theme.textMuted,
          align: "center",
        }),
      );
      break;
    }
  }

  return { archetype: "free", background: bg, elements: els, notes: slide.notes };
}

function headingEl(theme: Theme, title: string): TextElement {
  return newText(theme, {
    text: title,
    x: MARGIN,
    y: 90,
    w: CONTENT_W,
    h: 80,
    fontSize: 40,
    fontWeight: 800,
    color: theme.text,
    fontFamily: theme.fontHeading,
  });
}

/** Convert a whole deck to freeform (idempotent for already-free slides). */
export function deckToFree(deck: { theme: Theme; slides: SlideSpec[] }): FreeDeck {
  return {
    theme: deck.theme,
    slides: deck.slides.map((s) => slideToFree(s, deck.theme)),
  };
}

export function blankFreeSlide(theme: Theme): FreeSlide {
  return { archetype: "free", background: theme.bg, elements: [] };
}
