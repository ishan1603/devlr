"use client";

import { useEffect, useRef } from "react";

/**
 * A slowly turning graph of points: the dependency graph as scenery.
 *
 * Real 3D (points on a sphere, rotated and perspective-projected), drawn on a
 * 2D canvas. That is about a hundred lines and zero dependencies, where a
 * WebGL library would be tens of kilobytes for the same picture.
 *
 * It is decoration, so it gets out of the way: it starts only when the browser
 * is idle, stops when scrolled off screen or the tab is hidden, draws a single
 * still frame for visitors who prefer reduced motion, and does not run at all
 * on Save-Data connections.
 */

const POINTS = 96;
const LINK_DISTANCE = 0.62;
const ROTATION_PER_SECOND = 0.07;

interface Point {
  x: number;
  y: number;
  z: number;
}

/** Evenly spread points on a unit sphere, jittered so it does not look like a grid. */
function spherePoints(count: number): Point[] {
  const points: Point[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    // Deterministic jitter: the same picture on the server-less first frame
    // and on every visit.
    const jitter = 0.82 + (((i * 9301 + 49297) % 233280) / 233280) * 0.36;
    points.push({ x: Math.cos(theta) * radius * jitter, y: y * jitter, z: Math.sin(theta) * radius * jitter });
  }
  return points;
}

export default function Constellation({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const points = spherePoints(POINTS);

    // Which points are linked never changes as the sphere turns, so the pairs
    // are worked out once rather than every frame.
    const links: [number, number][] = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const dz = points[i].z - points[j].z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < LINK_DISTANCE) links.push([i, j]);
      }
    }

    let width = 0;
    let height = 0;
    let color = "";

    const readColor = () => {
      color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // Capped at 2x: a 3x phone screen would triple the pixels for no visible gain.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const projected = points.map(() => ({ x: 0, y: 0, depth: 0 }));

    const draw = (angle: number) => {
      context.clearRect(0, 0, width, height);
      const scale = Math.min(width, height) * 0.46;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const tilt = 0.35;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        // Rotate around Y, then tip toward the viewer around X.
        const x = p.x * cos - p.z * sin;
        const z0 = p.x * sin + p.z * cos;
        const y = p.y * cosT - z0 * sinT;
        const z = p.y * sinT + z0 * cosT;
        const perspective = 2.6 / (2.6 + z);
        projected[i].x = width / 2 + x * scale * perspective;
        projected[i].y = height / 2 + y * scale * perspective;
        // 0 at the back, 1 at the front.
        projected[i].depth = (1 - z) / 2;
      }

      context.strokeStyle = color;
      context.lineWidth = 1;
      for (const [a, b] of links) {
        const depth = (projected[a].depth + projected[b].depth) / 2;
        context.globalAlpha = 0.04 + depth * 0.2;
        context.beginPath();
        context.moveTo(projected[a].x, projected[a].y);
        context.lineTo(projected[b].x, projected[b].y);
        context.stroke();
      }

      context.fillStyle = color;
      for (const p of projected) {
        context.globalAlpha = 0.18 + p.depth * 0.72;
        context.beginPath();
        context.arc(p.x, p.y, 0.8 + p.depth * 1.5, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    let frame = 0;
    let running = false;
    let visible = true;
    let angle = 0.6;
    let last = 0;

    const tick = (now: number) => {
      if (!running) return;
      // Clamped so returning to a background tab does not jump the rotation.
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      angle += delta * ROTATION_PER_SECOND;
      draw(angle);
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || reduceMotion || !visible || document.hidden) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };

    readColor();
    resize();
    draw(angle);

    const onResize = () => {
      resize();
      draw(angle);
    };
    window.addEventListener("resize", onResize);

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else stop();
    });
    observer.observe(canvas);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    // The accent colour differs between themes; follow the toggle.
    const themeObserver = new MutationObserver(() => {
      readColor();
      draw(angle);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    // Wait for an idle moment so this never competes with first paint.
    const hasIdle = typeof window.requestIdleCallback === "function";
    const idle = hasIdle
      ? window.requestIdleCallback(start, { timeout: 1200 })
      : window.setTimeout(start, 300);

    return () => {
      stop();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      themeObserver.disconnect();
      if (hasIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
