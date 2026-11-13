/** Renders page 1 of a PDF onto a canvas with pdf.js, scaled so the whole page fits the pane. */
import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
// Loading the worker module in the page lets pdf.js run it on the main thread,
// so the single-file build needs no separate worker file. One page renders fast.
import "pdfjs-dist/build/pdf.worker.min.mjs";
import { fitScale } from "../lib/fit";

type Props = { pdf: Uint8Array | null; busy?: boolean };

/** Space left around the page inside the pane, in CSS pixels. */
const MARGIN = 24;
/** US Letter in PDF points, for the placeholder before a PDF exists. */
const LETTER = { width: 612, height: 792 };

export default function PdfPreview({ pdf, busy }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState<string | null>(null);

  // Re-fit whenever the pane changes size (window resize, split view drag).
  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(([e]) =>
      setBox({
        width: Math.max(0, Math.floor(e.contentRect.width) - 2 * MARGIN),
        height: Math.max(0, Math.floor(e.contentRect.height) - 2 * MARGIN),
      }),
    );
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvas.current || box.width < 50 || box.height < 50) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;
    const doc = pdfjs.getDocument({ data: pdf.slice() });
    (async () => {
      try {
        const d = await doc.promise;
        const page = await d.getPage(1);
        if (cancelled || !canvas.current) return;
        const scale = fitScale(page.getViewport({ scale: 1 }), box);
        // Draw at the screen's pixel density so text stays sharp.
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const vp = page.getViewport({ scale: scale * dpr });
        const c = canvas.current;
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        c.style.width = `${Math.floor(vp.width / dpr)}px`;
        c.style.height = `${Math.floor(vp.height / dpr)}px`;
        task = page.render({ canvas: c, viewport: vp });
        await task.promise;
        setFailed(null);
      } catch (e) {
        if (!cancelled && !(e instanceof Error && e.name === "RenderingCancelledException")) setFailed(String(e));
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      doc.destroy();
    };
  }, [pdf, box]);

  const placeholder = fitScale(LETTER, box);
  return (
    <div ref={host} className="pdf-fit">
      {failed ? (
        <div className="notice" data-tone="error" style={{ width: "100%" }}>
          <div className="notice-body">
            <span className="notice-title">The preview could not be drawn</span>
            <span className="muted small">{failed}</span>
          </div>
        </div>
      ) : pdf ? (
        <div className="paper" data-busy={busy}>
          <canvas ref={canvas} aria-label="Resume preview, page 1" role="img" />
        </div>
      ) : (
        <PaperSkeleton width={LETTER.width * placeholder} />
      )}
    </div>
  );
}

export function PaperSkeleton({ width }: { width: number }) {
  const lines = [38, 70, 0, 92, 84, 88, 0, 90, 76, 86, 80, 0, 88, 72, 90, 64, 0, 94, 70];
  return (
    <div className="paper-skeleton" style={{ width: Math.max(120, width) }} aria-hidden="true">
      {lines.map((w, i) => (w ? <i key={i} style={{ width: `${w}%`, justifySelf: i < 2 ? "center" : undefined }} /> : <span key={i} style={{ height: 8 }} />))}
    </div>
  );
}
