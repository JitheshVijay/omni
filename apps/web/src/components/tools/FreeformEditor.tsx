// Hands-on (Adobe/Canva-style) freeform slide editor. Every element is a
// draggable, resizable, deletable box positioned anywhere on the 1280x720
// canvas; text is edited inline. Dependency-free: custom pointer-based drag +
// resize so behaviour is fully predictable. Persists via onSave(FreeDeck).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BringToFront,
  Copy,
  Image as ImageIcon,
  Loader2,
  Plus,
  SendToBack,
  Square,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { SLIDE_H, SLIDE_W } from "@/lib/slide-types";
import {
  blankFreeSlide,
  newImage,
  newShape,
  newText,
  type FreeDeck,
  type FreeElement,
  type FreeSlide,
} from "@/lib/slide-free";
import { FreeElementContent } from "./FreeSlideView";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Dir = (typeof DIRS)[number];
const MIN = 24;

export function FreeformEditor({
  deck,
  title,
  onSave,
  onExit,
}: {
  deck: FreeDeck;
  title: string;
  onSave: (deck: FreeDeck) => Promise<void> | void;
  onExit: () => void;
}) {
  const theme = deck.theme;
  const [slides, setSlides] = useState<FreeSlide[]>(deck.slides);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth));
    ro.observe(el);
    setCanvasW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const scale = Math.max(0.1, canvasW / SLIDE_W);

  const slide = slides[Math.min(slideIdx, slides.length - 1)] ?? slides[0];
  const selected = slide?.elements.find((e) => e.id === selectedId) ?? null;

  const patchSlide = useCallback(
    (fn: (s: FreeSlide) => FreeSlide) => {
      setSlides((prev) => prev.map((s, i) => (i === slideIdx ? fn(s) : s)));
      setDirty(true);
    },
    [slideIdx],
  );

  const patchEl = useCallback(
    (id: string, patch: Partial<FreeElement>) => {
      patchSlide((s) => ({
        ...s,
        elements: s.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as FreeElement) : e)),
      }));
    },
    [patchSlide],
  );

  const addElement = useCallback(
    (el: FreeElement) => {
      const maxZ = slide ? slide.elements.reduce((m, e) => Math.max(m, e.z), -1) : -1;
      const placed = { ...el, z: maxZ + 1 } as FreeElement;
      patchSlide((s) => ({ ...s, elements: [...s.elements, placed] }));
      setSelectedId(placed.id);
    },
    [patchSlide, slide],
  );

  const removeEl = useCallback(
    (id: string) => {
      patchSlide((s) => ({ ...s, elements: s.elements.filter((e) => e.id !== id) }));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [patchSlide],
  );

  const restack = useCallback(
    (id: string, toFront: boolean) => {
      patchSlide((s) => {
        const zs = s.elements.map((e) => e.z);
        const z = toFront ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
        return { ...s, elements: s.elements.map((e) => (e.id === id ? { ...e, z } : e)) };
      });
    },
    [patchSlide],
  );

  const duplicateEl = useCallback(
    (el: FreeElement) => addElement({ ...el, id: `${el.id}_c`, x: el.x + 24, y: el.y + 24 }),
    [addElement],
  );

  // ── pointer drag / resize ─────────────────────────────────────────
  function beginDrag(e: React.PointerEvent, el: FreeElement) {
    if (editingId) return;
    e.stopPropagation();
    setSelectedId(el.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = el.x;
    const oy = el.y;
    const move = (ev: PointerEvent) => {
      patchEl(el.id, {
        x: Math.round(ox + (ev.clientX - sx) / scale),
        y: Math.round(oy + (ev.clientY - sy) / scale),
      });
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function beginResize(e: React.PointerEvent, el: FreeElement, dir: Dir) {
    e.stopPropagation();
    setSelectedId(el.id);
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: el.x, y: el.y, w: el.w, h: el.h };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / scale;
      const dy = (ev.clientY - sy) / scale;
      let { x, y, w, h } = o;
      if (dir.includes("e")) w = o.w + dx;
      if (dir.includes("s")) h = o.h + dy;
      if (dir.includes("w")) {
        w = o.w - dx;
        x = o.x + dx;
      }
      if (dir.includes("n")) {
        h = o.h - dy;
        y = o.y + dy;
      }
      if (w < MIN) {
        if (dir.includes("w")) x = o.x + o.w - MIN;
        w = MIN;
      }
      if (h < MIN) {
        if (dir.includes("n")) y = o.y + o.h - MIN;
        h = MIN;
      }
      patchEl(el.id, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ── keyboard ──────────────────────────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent) {
    if (editingId || !selected) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeEl(selected.id);
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      patchEl(selected.id, { x: selected.x + dx, y: selected.y + dy });
    }
  }

  // ── slide filmstrip ops ───────────────────────────────────────────
  function addSlide() {
    setSlides((p) => {
      const next = [...p];
      next.splice(slideIdx + 1, 0, blankFreeSlide(theme));
      return next;
    });
    setSlideIdx((i) => i + 1);
    setDirty(true);
  }
  function duplicateSlide() {
    setSlides((p) => {
      const clone: FreeSlide = {
        ...p[slideIdx],
        elements: p[slideIdx].elements.map((e) => ({ ...e, id: `${e.id}_d` })),
      };
      const next = [...p];
      next.splice(slideIdx + 1, 0, clone);
      return next;
    });
    setSlideIdx((i) => i + 1);
    setDirty(true);
  }
  function deleteSlide() {
    if (slides.length <= 1) return;
    setSlides((p) => p.filter((_, i) => i !== slideIdx));
    setSlideIdx((i) => Math.max(0, i - 1));
    setSelectedId(null);
    setDirty(true);
  }
  function moveSlide(delta: number) {
    setSlides((p) => {
      const j = slideIdx + delta;
      if (j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[slideIdx], next[j]] = [next[j], next[slideIdx]];
      return next;
    });
    setSlideIdx((i) => Math.min(slides.length - 1, Math.max(0, i + delta)));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({ theme, slides });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  const sorted = useMemo(
    () => (slide ? [...slide.elements].sort((a, b) => a.z - b.z) : []),
    [slide],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface2">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-2">
        <span className="mr-1 truncate text-sm font-medium text-ink">{title || "Untitled deck"}</span>
        <div className="mx-1 h-5 w-px bg-line" />
        <ToolBtn onClick={() => addElement(newText(theme))} icon={<Type />} label="Text" />
        <ToolBtn onClick={() => addElement(newShape(theme))} icon={<Square />} label="Box" />
        <ToolBtn onClick={() => addElement(newImage())} icon={<ImageIcon />} label="Image" />
        <div className="mx-1 h-5 w-px bg-line" />
        <ToolBtn
          onClick={() => selected && restack(selected.id, true)}
          disabled={!selected}
          icon={<BringToFront />}
          label="Front"
        />
        <ToolBtn
          onClick={() => selected && restack(selected.id, false)}
          disabled={!selected}
          icon={<SendToBack />}
          label="Back"
        />
        <ToolBtn
          onClick={() => selected && duplicateEl(selected)}
          disabled={!selected}
          icon={<Copy />}
          label="Duplicate"
        />
        <ToolBtn
          onClick={() => selected && removeEl(selected.id)}
          disabled={!selected}
          icon={<Trash2 />}
          label="Delete"
        />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onExit}>
            <X /> Close
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* filmstrip */}
        <div className="flex w-40 shrink-0 flex-col gap-2 overflow-y-auto scrollbar-thin border-r border-line bg-surface p-2">
          {slides.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setSlideIdx(i);
                setSelectedId(null);
              }}
              className={cn(
                "relative overflow-hidden rounded-md border text-left transition",
                i === slideIdx ? "border-accent ring-1 ring-accent" : "border-line hover:border-muted",
              )}
              style={{ aspectRatio: `${SLIDE_W} / ${SLIDE_H}` }}
            >
              <div
                style={{
                  width: SLIDE_W,
                  height: SLIDE_H,
                  transform: `scale(${136 / SLIDE_W})`,
                  transformOrigin: "top left",
                  background: s.background,
                  position: "relative",
                }}
              >
                {[...s.elements]
                  .sort((a, b) => a.z - b.z)
                  .map((el) => (
                    <div
                      key={el.id}
                      style={{
                        position: "absolute",
                        left: el.x,
                        top: el.y,
                        width: el.w,
                        height: el.h,
                        zIndex: el.z,
                      }}
                    >
                      <FreeElementContent el={el} />
                    </div>
                  ))}
              </div>
              <span className="absolute bottom-0.5 left-1 rounded bg-black/40 px-1 text-[9px] text-white">
                {i + 1}
              </span>
            </button>
          ))}
          <div className="flex flex-wrap gap-1 pt-1">
            <MiniBtn onClick={addSlide} title="Add slide">
              <Plus className="size-3.5" />
            </MiniBtn>
            <MiniBtn onClick={duplicateSlide} title="Duplicate slide">
              <Copy className="size-3.5" />
            </MiniBtn>
            <MiniBtn onClick={() => moveSlide(-1)} title="Move up" disabled={slideIdx === 0}>
              ↑
            </MiniBtn>
            <MiniBtn
              onClick={() => moveSlide(1)}
              title="Move down"
              disabled={slideIdx >= slides.length - 1}
            >
              ↓
            </MiniBtn>
            <MiniBtn onClick={deleteSlide} title="Delete slide" disabled={slides.length <= 1}>
              <Trash2 className="size-3.5" />
            </MiniBtn>
          </div>
        </div>

        {/* canvas */}
        <div
          ref={wrapRef}
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {slide ? (
            <div style={{ width: SLIDE_W * scale, height: SLIDE_H * scale, flexShrink: 0 }}>
              <div
                style={{
                  width: SLIDE_W,
                  height: SLIDE_H,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  position: "relative",
                  background: slide.background,
                  boxShadow: "0 8px 40px rgba(0,0,0,.18)",
                }}
                onPointerDown={() => setSelectedId(null)}
              >
                {sorted.map((el) => {
                  const isSel = el.id === selectedId;
                  const isEditing = el.id === editingId;
                  return (
                    <div
                      key={el.id}
                      style={{
                        position: "absolute",
                        left: el.x,
                        top: el.y,
                        width: el.w,
                        height: el.h,
                        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                        zIndex: el.z,
                        cursor: isEditing ? "text" : "move",
                        outline: isSel ? `2px solid ${theme.accent}` : "none",
                        outlineOffset: 1,
                        userSelect: "none",
                        WebkitUserSelect: "none",
                        touchAction: "none",
                      }}
                      onPointerDown={(e) => beginDrag(e, el)}
                      onDoubleClick={(e) => {
                        if (el.type === "text") {
                          e.stopPropagation();
                          setEditingId(el.id);
                          setSelectedId(el.id);
                        }
                      }}
                    >
                      {isEditing && el.type === "text" ? (
                        <textarea
                          autoFocus
                          value={el.text}
                          onChange={(e) => patchEl(el.id, { text: e.target.value })}
                          onBlur={() => setEditingId(null)}
                          onPointerDown={(e) => e.stopPropagation()}
                          style={{
                            width: "100%",
                            height: "100%",
                            resize: "none",
                            border: "none",
                            outline: "none",
                            background: "transparent",
                            padding: 0,
                            margin: 0,
                            fontFamily: el.fontFamily,
                            fontSize: el.fontSize,
                            fontWeight: el.fontWeight,
                            color: el.color,
                            textAlign: el.align,
                            fontStyle: el.italic ? "italic" : "normal",
                            lineHeight: String(el.lineHeight ?? 1.3),
                          }}
                        />
                      ) : (
                        <FreeElementContent el={el} />
                      )}

                      {isSel && !isEditing
                        ? DIRS.map((d) => (
                            <span
                              key={d}
                              onPointerDown={(e) => beginResize(e, el, d)}
                              style={handleStyle(d, theme.accent)}
                            />
                          ))
                        : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ToolBtn({
  onClick,
  icon,
  label,
  disabled,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted transition hover:bg-surface2 hover:text-ink disabled:opacity-40 [&_svg]:size-3.5"
    >
      {icon}
      {label}
    </button>
  );
}

function MiniBtn({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="grid size-7 place-items-center rounded-md border border-line text-xs text-muted transition hover:bg-surface2 hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function handleStyle(dir: Dir, color: string): React.CSSProperties {
  const S = 12;
  const at: Record<Dir, React.CSSProperties> = {
    nw: { left: -S / 2, top: -S / 2, cursor: "nwse-resize" },
    n: { left: `calc(50% - ${S / 2}px)`, top: -S / 2, cursor: "ns-resize" },
    ne: { right: -S / 2, top: -S / 2, cursor: "nesw-resize" },
    e: { right: -S / 2, top: `calc(50% - ${S / 2}px)`, cursor: "ew-resize" },
    se: { right: -S / 2, bottom: -S / 2, cursor: "nwse-resize" },
    s: { left: `calc(50% - ${S / 2}px)`, bottom: -S / 2, cursor: "ns-resize" },
    sw: { left: -S / 2, bottom: -S / 2, cursor: "nesw-resize" },
    w: { left: -S / 2, top: `calc(50% - ${S / 2}px)`, cursor: "ew-resize" },
  };
  return {
    position: "absolute",
    width: S,
    height: S,
    background: "#fff",
    border: `2px solid ${color}`,
    borderRadius: 3,
    boxSizing: "border-box",
    ...at[dir],
  };
}
