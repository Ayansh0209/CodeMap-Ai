"use client";

// NetworkBackdrop.tsx
// ─────────────────────────────────────────────────────────────────────────────
// A living "code map" behind the whole landing page: faint nodes drifting with
// thin edges drawn between nearby ones — the product's own metaphor as ambient
// motion. Canvas (no extra deps), pauses when the tab is hidden, and respects
// prefers-reduced-motion (renders a single static frame).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";

const COLORS = ["#fb7a3c", "#ec4899", "#a855f7"]; // coral · pink · violet

export default function NetworkBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let raf = 0;
    let w = 0;
    let h = 0;

    type P = { x: number; y: number; vx: number; vy: number; r: number; c: string };
    let pts: P[] = [];

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(18, Math.min(52, Math.floor((w * h) / 26000)));
      pts = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: 1.1 + Math.random() * 1.7,
        c: COLORS[Math.floor(Math.random() * COLORS.length)],
      }));
    };
    resize();

    const DIST = 150;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      // edges between nearby nodes — fade with distance
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i];
          const b = pts[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d < DIST) {
            ctx.strokeStyle = `rgba(251,122,60,${(1 - d / DIST) * 0.16})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // nodes
      for (const p of pts) {
        ctx.fillStyle = p.c;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (reduce) return; // static single frame
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
      raf = requestAnimationFrame(draw);
    };
    draw();

    const onResize = () => {
      resize();
      if (reduce) draw();
    };
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduce) raf = requestAnimationFrame(draw);
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 -z-10 w-full h-full pointer-events-none"
      style={{ opacity: 0.6 }}
    />
  );
}
