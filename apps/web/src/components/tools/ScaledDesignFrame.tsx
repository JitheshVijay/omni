// Renders a self-contained design document (a single #design-canvas sized to
// exactly width×height px) inside a sandboxed iframe, scaled with a CSS
// transform to fit whatever box this component is given. A ResizeObserver keeps
// the scale correct as the container resizes.
//
// The iframe is same-origin (srcDoc + allow-same-origin) so the viewer can read
// #design-canvas from contentDocument for PNG export; pass `iframeRef` to grab
// the element. `interactive={false}` (default) makes the preview inert.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function ScaledDesignFrame({
  html,
  width,
  height,
  title,
  className,
  iframeRef,
  interactive = false,
  onScale,
}: {
  html: string;
  width: number;
  height: number;
  title: string;
  className?: string;
  iframeRef?: React.Ref<HTMLIFrameElement>;
  interactive?: boolean;
  onScale?: (scale: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      if (bw > 0 && bh > 0) {
        const s = Math.min(bw / width, bh / height);
        setScale(s);
        onScale?.(s);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // onScale intentionally omitted, since callers pass a fresh closure each render.
  }, [width, height]);

  return (
    <div
      ref={boxRef}
      className={cn("relative flex items-center justify-center overflow-hidden", className)}
    >
      {scale > 0 && (
        <div
          className="relative shrink-0 overflow-hidden"
          style={{ width: width * scale, height: height * scale }}
        >
          <iframe
            ref={iframeRef}
            title={title}
            srcDoc={html}
            sandbox="allow-scripts allow-same-origin"
            className={cn(
              "absolute left-0 top-0 origin-top-left border-0 bg-white",
              !interactive && "pointer-events-none",
            )}
            style={{ width, height, transform: `scale(${scale})` }}
          />
        </div>
      )}
    </div>
  );
}
