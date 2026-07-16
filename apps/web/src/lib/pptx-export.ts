// Client-side .pptx export built FROM the deck JSON (not screenshots), so the
// deck opens in Keynote/PowerPoint with real editable text boxes and a NATIVE
// chart on chart slides. Each archetype maps to positioned text/shapes/images
// mirroring SlideRenderer's layout.
//
// The design canvas is 1280x720 px; PowerPoint works in inches. Both axes are
// exactly 96 px/in (1280/96 = 13.333, 720/96 = 7.5), so px -> in is a single
// divide and px -> pt is *0.75. Colours are the deck's embedded theme hex,
// with the leading '#' stripped (pptxgenjs wants bare hex).
//
// Slide art lives as child image artifacts; we fetch each one's blob and inline
// it as a data URI (the .pptx is self-contained). A missing image degrades to
// a themed placeholder rectangle, never a broken export.

import pptxgen from "pptxgenjs";
import { authFetchRaw } from "@/lib/use-api";
import {
  SLIDE_H,
  SLIDE_W,
  type Column,
  type DeckContent,
  type ImageTextSlide,
  type SlideSpec,
  type Theme,
} from "@/lib/slide-types";

// ─── Unit + colour helpers ──────────────────────────────────────────

const PAD = 88; // matches SlideRenderer's PAD
const IN = (px: number) => px / 96; // px -> inches
const PT = (px: number) => Math.round(px * 0.75); // px -> points
const LAYOUT = "OMNI_16x9";

/** Bare 6-hex for pptxgenjs (strips '#', tolerates shorthand). */
function hx(hex: string): string {
  let h = (hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : "000000";
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hx(hex);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** accent2 -> accent ramp for pie slices (mirrors the renderer's tintRamp). */
function tintRamp(theme: Theme, n: number): string[] {
  if (n <= 1) return [hx(theme.accent)];
  return Array.from({ length: n }, (_, i) => mix(theme.accent2, theme.accent, i / (n - 1)));
}

const CONTENT_W = SLIDE_W - PAD * 2; // 1104px usable width

// ─── Image fetch → data URI ─────────────────────────────────────────

async function imageDataUrl(imgId: string): Promise<string | null> {
  try {
    const res = await authFetchRaw(`/api/artifacts/${imgId}/blob`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(typeof fr.result === "string" ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ─── Per-archetype builders ─────────────────────────────────────────

type Slide = ReturnType<InstanceType<typeof pptxgen>["addSlide"]>;

function bulletRuns(items: string[]) {
  return items.map((t) => ({
    text: t,
    options: { bullet: { indent: 18 }, breakLine: true },
  }));
}

function heading(slide: Slide, theme: Theme, title: string, subtitle?: string) {
  // Accent tab + title, mirroring SlideHeading.
  slide.addShape("rect", {
    x: IN(PAD),
    y: IN(PAD + 8),
    w: IN(40),
    h: IN(6),
    fill: { color: hx(theme.accent) },
  });
  slide.addText(title, {
    x: IN(PAD + 56),
    y: IN(PAD - 8),
    w: IN(CONTENT_W - 56),
    h: IN(70),
    fontSize: PT(44),
    bold: true,
    color: hx(theme.text),
    fontFace: theme.fontHeading,
    valign: "top",
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: IN(PAD + 56),
      y: IN(PAD + 58),
      w: IN(CONTENT_W - 56),
      h: IN(40),
      fontSize: PT(22),
      color: hx(theme.textMuted),
      fontFace: theme.fontBody,
      valign: "top",
    });
  }
}

function buildTitle(
  slide: Slide,
  theme: Theme,
  slide_: Extract<SlideSpec, { archetype: "title" }>,
) {
  let y = 230;
  if (slide_.eyebrow) {
    slide.addText(slide_.eyebrow.toUpperCase(), {
      x: IN(PAD + 24),
      y: IN(y),
      w: IN(CONTENT_W),
      h: IN(34),
      fontSize: PT(18),
      bold: true,
      color: hx(theme.accent),
      charSpacing: 3,
      fontFace: theme.fontBody,
    });
    y += 46;
  }
  slide.addText(slide_.title, {
    x: IN(PAD + 24),
    y: IN(y),
    w: IN(1000),
    h: IN(200),
    fontSize: PT(80),
    bold: true,
    color: hx(theme.text),
    fontFace: theme.fontHeading,
    valign: "top",
    lineSpacingMultiple: 1.02,
  });
  y += 210;
  if (slide_.subtitle) {
    slide.addText(slide_.subtitle, {
      x: IN(PAD + 24),
      y: IN(y),
      w: IN(840),
      h: IN(90),
      fontSize: PT(28),
      color: hx(theme.textMuted),
      fontFace: theme.fontBody,
      valign: "top",
    });
  }
  slide.addShape("rect", {
    x: IN(PAD + 24),
    y: IN(620),
    w: IN(120),
    h: IN(6),
    fill: { color: hx(theme.accent) },
  });
}

function buildSection(
  slide: Slide,
  theme: Theme,
  slide_: Extract<SlideSpec, { archetype: "section" }>,
) {
  slide.addText("SECTION", {
    x: IN(PAD),
    y: IN(240),
    w: IN(CONTENT_W),
    h: IN(34),
    fontSize: PT(20),
    bold: true,
    color: hx(theme.accent),
    charSpacing: 4,
    fontFace: theme.fontBody,
  });
  slide.addText(slide_.title, {
    x: IN(PAD),
    y: IN(288),
    w: IN(1020),
    h: IN(160),
    fontSize: PT(64),
    bold: true,
    color: hx(theme.text),
    fontFace: theme.fontHeading,
    valign: "top",
  });
  if (slide_.subtitle) {
    slide.addText(slide_.subtitle, {
      x: IN(PAD),
      y: IN(452),
      w: IN(880),
      h: IN(80),
      fontSize: PT(26),
      color: hx(theme.textMuted),
      fontFace: theme.fontBody,
      valign: "top",
    });
  }
}

function buildBullets(
  slide: Slide,
  theme: Theme,
  slide_: Extract<SlideSpec, { archetype: "bullets" }>,
) {
  heading(slide, theme, slide_.title, slide_.subtitle);
  const dense = slide_.bullets.length > 4;
  slide.addText(bulletRuns(slide_.bullets), {
    x: IN(PAD),
    y: IN(slide_.subtitle ? 250 : 220),
    w: IN(CONTENT_W),
    h: IN(slide_.subtitle ? 380 : 410),
    fontSize: PT(dense ? 26 : 30),
    color: hx(theme.text),
    fontFace: theme.fontBody,
    valign: "middle",
    paraSpaceAfter: dense ? 10 : 16,
    lineSpacingMultiple: 1.1,
  });
}

function columnCard(slide: Slide, theme: Theme, col: Column, x: number, w: number) {
  const y = 240;
  const h = 400;
  slide.addShape("roundRect", {
    x: IN(x),
    y: IN(y),
    w: IN(w),
    h: IN(h),
    fill: { color: hx(theme.surface) },
    line: { color: hx(theme.border), width: 1 },
    rectRadius: 0.18,
  });
  if (col.heading) {
    slide.addText(col.heading, {
      x: IN(x + 32),
      y: IN(y + 28),
      w: IN(w - 64),
      h: IN(44),
      fontSize: PT(28),
      bold: true,
      color: hx(theme.accent),
      fontFace: theme.fontHeading,
      valign: "top",
    });
  }
  slide.addText(bulletRuns(col.points), {
    x: IN(x + 32),
    y: IN(y + (col.heading ? 92 : 32)),
    w: IN(w - 64),
    h: IN(h - (col.heading ? 116 : 56)),
    fontSize: PT(22),
    color: hx(theme.text),
    fontFace: theme.fontBody,
    valign: "top",
    paraSpaceAfter: 8,
    lineSpacingMultiple: 1.1,
  });
}

function buildTwoCol(
  slide: Slide,
  theme: Theme,
  slide_: Extract<SlideSpec, { archetype: "two-col" }>,
) {
  heading(slide, theme, slide_.title);
  const gap = 28;
  const colW = (CONTENT_W - gap) / 2;
  columnCard(slide, theme, slide_.left, PAD, colW);
  columnCard(slide, theme, slide_.right, PAD + colW + gap, colW);
}

function buildImageText(
  slide: Slide,
  theme: Theme,
  slide_: ImageTextSlide,
  dataUri: string | null,
) {
  const gap = 44;
  const imgW = Math.round(0.46 * CONTENT_W); // ~508
  const textW = CONTENT_W - imgW - gap;
  const imgH = SLIDE_H - PAD * 2; // 544
  const onLeft = slide_.image_side === "left";
  const imgX = onLeft ? PAD : PAD + textW + gap;
  const textX = onLeft ? PAD + imgW + gap : PAD;

  // Image (or placeholder panel).
  if (dataUri) {
    slide.addImage({
      data: dataUri,
      x: IN(imgX),
      y: IN(PAD),
      w: IN(imgW),
      h: IN(imgH),
      sizing: { type: "cover", w: IN(imgW), h: IN(imgH) },
    });
  } else {
    slide.addShape("roundRect", {
      x: IN(imgX),
      y: IN(PAD),
      w: IN(imgW),
      h: IN(imgH),
      fill: { color: hx(theme.surface) },
      line: { color: hx(theme.border), width: 1 },
      rectRadius: 0.18,
    });
    slide.addText(slide_.image_prompt, {
      x: IN(imgX + 28),
      y: IN(PAD + 28),
      w: IN(imgW - 56),
      h: IN(imgH - 56),
      fontSize: PT(18),
      italic: true,
      color: hx(theme.textMuted),
      align: "center",
      valign: "middle",
      fontFace: theme.fontBody,
    });
  }

  // Text column.
  slide.addShape("rect", {
    x: IN(textX),
    y: IN(PAD + 8),
    w: IN(40),
    h: IN(6),
    fill: { color: hx(theme.accent) },
  });
  slide.addText(slide_.title, {
    x: IN(textX + 56),
    y: IN(PAD - 8),
    w: IN(textW - 56),
    h: IN(70),
    fontSize: PT(40),
    bold: true,
    color: hx(theme.text),
    fontFace: theme.fontHeading,
    valign: "top",
  });
  slide.addText(bulletRuns(slide_.body), {
    x: IN(textX),
    y: IN(PAD + 80),
    w: IN(textW),
    h: IN(imgH - 100),
    fontSize: PT(24),
    color: hx(theme.text),
    fontFace: theme.fontBody,
    valign: "top",
    paraSpaceAfter: 12,
    lineSpacingMultiple: 1.1,
  });
  if (slide_.caption) {
    slide.addText(slide_.caption, {
      x: IN(imgX + 20),
      y: IN(PAD + imgH - 44),
      w: IN(imgW - 40),
      h: IN(30),
      fontSize: PT(16),
      color: "FFFFFF",
      fontFace: theme.fontBody,
    });
  }
}

function buildQuote(
  slide: Slide,
  theme: Theme,
  slide_: Extract<SlideSpec, { archetype: "quote" }>,
) {
  slide.addText("“", {
    x: IN(PAD),
    y: IN(120),
    w: IN(CONTENT_W),
    h: IN(120),
    fontSize: PT(150),
    color: hx(theme.accent),
    align: "center",
    fontFace: theme.fontHeading,
    transparency: 55,
  });
  slide.addText(slide_.quote, {
    x: IN(128),
    y: IN(268),
    w: IN(SLIDE_W - 256),
    h: IN(220),
    fontSize: PT(46),
    bold: true,
    color: hx(theme.text),
    align: "center",
    valign: "middle",
    fontFace: theme.fontHeading,
    lineSpacingMultiple: 1.2,
  });
  if (slide_.attribution) {
    slide.addText(`by  ${slide_.attribution}`, {
      x: IN(128),
      y: IN(516),
      w: IN(SLIDE_W - 256),
      h: IN(44),
      fontSize: PT(22),
      color: hx(theme.textMuted),
      align: "center",
      fontFace: theme.fontBody,
    });
  }
}

function buildChart(
  slide: Slide,
  theme: Theme,
  slide_: Extract<SlideSpec, { archetype: "chart" }>,
) {
  const chart = slide_.chart;
  heading(slide, theme, slide_.title, chart.series_label);
  const data = [
    {
      name: chart.series_label || slide_.title,
      labels: chart.categories,
      values: chart.values,
    },
  ];
  const region = {
    x: IN(PAD),
    y: IN(240),
    w: IN(CONTENT_W),
    h: IN(chart.caption ? 330 : 360),
  } as const;

  if (chart.type === "pie") {
    slide.addChart("pie", data, {
      ...region,
      chartColors: tintRamp(theme, chart.values.length),
      showLegend: true,
      legendPos: "r",
      legendColor: hx(theme.text),
      showValue: true,
      showPercent: false,
      dataLabelColor: hx(theme.bg),
      dataLabelFontSize: PT(16),
      showTitle: false,
    });
  } else {
    slide.addChart(chart.type === "line" ? "line" : "bar", data, {
      ...region,
      barDir: "col",
      chartColors: [hx(theme.accent)],
      showLegend: false,
      showValue: true,
      showTitle: false,
      valAxisHidden: true,
      valGridLine: { style: "none" },
      catGridLine: { style: "none" },
      catAxisLabelColor: hx(theme.textMuted),
      catAxisLabelFontSize: PT(18),
      dataLabelColor: hx(theme.text),
      dataLabelFontSize: PT(18),
      dataLabelPosition: chart.type === "line" ? "t" : "outEnd",
      lineSize: chart.type === "line" ? 3 : undefined,
      lineDataSymbol: "circle",
    });
  }
  if (chart.caption) {
    slide.addText(chart.caption, {
      x: IN(PAD + 56),
      y: IN(600),
      w: IN(CONTENT_W - 56),
      h: IN(36),
      fontSize: PT(18),
      color: hx(theme.textMuted),
      fontFace: theme.fontBody,
    });
  }
}

// Freeform slides: map each positioned element to a pptx text/shape/image at
// the same 1280x720 coordinates.
function buildFree(
  slide: Slide,
  spec: Extract<SlideSpec, { archetype: "free" }>,
  artById: Map<string, string | null>,
) {
  slide.background = { color: hx(spec.background) };
  for (const el of [...spec.elements].sort((a, b) => a.z - b.z)) {
    const box = { x: IN(el.x), y: IN(el.y), w: IN(el.w), h: IN(el.h) };
    if (el.type === "text") {
      slide.addText(el.text, {
        ...box,
        fontSize: PT(el.fontSize),
        bold: el.fontWeight >= 600,
        italic: el.italic ?? false,
        color: hx(el.color),
        fontFace: el.fontFamily,
        align: el.align,
        valign: "top",
      });
    } else if (el.type === "shape") {
      slide.addShape(el.shape === "ellipse" ? "ellipse" : "rect", {
        ...box,
        fill: { color: hx(el.fill) },
      });
    } else {
      const data = el.artifactId ? artById.get(el.artifactId) : el.src;
      if (data) {
        slide.addImage({ ...box, data, sizing: { type: el.fit, w: box.w, h: box.h } });
      } else {
        slide.addShape("rect", { ...box, fill: { color: hx("#e5e7eb") } });
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Build a .pptx Blob from a deck. Fetches slide art up front (in parallel) so
 * images are embedded; a failed fetch degrades to a placeholder panel.
 */
export async function exportDeckToPptx(deck: DeckContent, title: string): Promise<Blob> {
  const pres = new pptxgen();
  pres.defineLayout({ name: LAYOUT, width: IN(SLIDE_W), height: IN(SLIDE_H) });
  pres.layout = LAYOUT;
  pres.author = "Omni";
  pres.title = title || "Presentation";

  const theme = deck.theme;

  // Pre-fetch every image+text slide's art as a data URI.
  const artEntries = await Promise.all(
    deck.slides.map(async (s) =>
      s.archetype === "image+text" && s.image_artifact_id
        ? ([s.image_artifact_id, await imageDataUrl(s.image_artifact_id)] as const)
        : null,
    ),
  );
  const artById = new Map<string, string | null>();
  for (const e of artEntries) if (e) artById.set(e[0], e[1]);

  // Also pre-fetch images referenced by freeform slides.
  const freeImgIds = new Set<string>();
  for (const s of deck.slides) {
    if (s.archetype === "free") {
      for (const el of s.elements) {
        if (el.type === "image" && el.artifactId) freeImgIds.add(el.artifactId);
      }
    }
  }
  await Promise.all(
    [...freeImgIds]
      .filter((id) => !artById.has(id))
      .map(async (id) => artById.set(id, await imageDataUrl(id))),
  );

  for (const spec of deck.slides) {
    const slide = pres.addSlide();
    slide.background = { color: hx(theme.bgFrom) };
    switch (spec.archetype) {
      case "title":
        buildTitle(slide, theme, spec);
        break;
      case "section":
        buildSection(slide, theme, spec);
        break;
      case "bullets":
        buildBullets(slide, theme, spec);
        break;
      case "two-col":
        buildTwoCol(slide, theme, spec);
        break;
      case "image+text":
        buildImageText(
          slide,
          theme,
          spec,
          spec.image_artifact_id ? (artById.get(spec.image_artifact_id) ?? null) : null,
        );
        break;
      case "quote":
        buildQuote(slide, theme, spec);
        break;
      case "chart":
        buildChart(slide, theme, spec);
        break;
      case "free":
        buildFree(slide, spec, artById);
        break;
    }
    if ("notes" in spec && spec.notes) slide.addNotes(spec.notes);
  }

  const out = await pres.write({ outputType: "blob" });
  return out as Blob;
}
