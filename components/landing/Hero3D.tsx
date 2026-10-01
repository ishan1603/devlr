"use client";

import { useEffect, useRef } from "react";
import Constellation from "@/components/landing/Constellation";

/**
 * The hero: a stack of issue fragments floating in 3D.
 *
 * The depth is plain CSS (`perspective` plus `translateZ` on each card), so the
 * scene costs no JavaScript to render. The only script is a pointer handler
 * that writes two custom properties, and the browser eases the stack toward
 * them. On touch screens and for reduced-motion visitors the stack simply sits
 * at its resting angle.
 */

/** Per-card position in the scene, passed to CSS as custom properties. */
function place(x: number, y: number, z: number, ry = 0, rx = 0, delay = 0): React.CSSProperties {
  return {
    "--x": `${x}px`,
    "--y": `${y}px`,
    "--z": `${z}px`,
    "--ry": `${ry}deg`,
    "--rx": `${rx}deg`,
    "--delay": `${delay}s`,
    "--float-delay": `${-delay * 3}s`,
  } as React.CSSProperties;
}

function CardShell({
  style,
  className,
  children,
}: {
  style: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={style}
      className={`hero-card overflow-hidden rounded-xl border border-line bg-surface shadow-pop ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] tracking-wide">
      <span className="text-subtle">{"// "}</span>
      <span className="text-accent">{children}</span>
    </p>
  );
}

function Lines({ widths }: { widths: string[] }) {
  return (
    <div className="mt-2 space-y-1.5">
      {widths.map((width, i) => (
        <div key={i} className="h-1.5 rounded-full bg-surface-sunken" style={{ width }} />
      ))}
    </div>
  );
}

export default function Hero3D() {
  const stageRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const tilt = tiltRef.current;
    if (!stage || !tilt) return;

    // No hover on a touch screen, and no motion for people who asked for none.
    const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!canHover || reduceMotion) return;

    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = stage.getBoundingClientRect();
        const px = (event.clientX - rect.left) / rect.width - 0.5;
        const py = (event.clientY - rect.top) / rect.height - 0.5;
        tilt.style.setProperty("--tx", `${(px * 14).toFixed(2)}deg`);
        tilt.style.setProperty("--ty", `${(-py * 10).toFixed(2)}deg`);
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      tilt.style.setProperty("--tx", "0deg");
      tilt.style.setProperty("--ty", "0deg");
    };

    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={stageRef}
      aria-hidden="true"
      className="relative mx-auto h-[400px] w-full max-w-[540px] select-none sm:h-[500px]"
    >
      <div className="glow pointer-events-none absolute inset-0 -z-10 scale-125" />
      <Constellation className="mask-fade pointer-events-none absolute inset-0 -z-10 size-full" />

      {/* Scaled down on narrow screens so the whole scene fits without
          clipping; the 3D positions are authored once, for the large size.
          The perspective lives here, on the direct parent of the tilting
          element: put it any higher and this wrapper flattens the scene. */}
      <div className="hero-stage absolute left-1/2 top-1/2 size-0 scale-[0.66] sm:scale-100">
        <div ref={tiltRef} className="hero-tilt relative size-0">
          {/* Back left: EOL Watch */}
          {/* Rows are stacked, not side by side: the right half of this card
              sits behind the issue, so everything it says is on the left. */}
          <CardShell style={place(-335, -50, -120, 14, 0, 0.25)} className="w-[230px] p-4">
            <Label>eol watch</Label>
            <div className="mt-3 space-y-3">
              {[
                ["Next.js 15", "20 days left", "text-warning"],
                ["Python 3.10", "30 days left", "text-warning"],
                ["PostgreSQL 14", "42 days left", "text-muted"],
              ].map(([name, left, tone]) => (
                <div key={name}>
                  <p className="text-[12px] font-semibold leading-tight">{name}</p>
                  <p className={`mt-0.5 font-mono text-[10px] ${tone}`}>{left}</p>
                </div>
              ))}
            </div>
          </CardShell>

          {/* Back right: Dev Pulse */}
          <CardShell style={place(95, -315, -200, -10, 0, 0.4)} className="w-[250px] p-4">
            <Label>dev pulse</Label>
            <div className="mt-3 space-y-3">
              {[
                ["acme/fast-router", "7.3k stars"],
                ["nine/tinybase-sync", "3.5k stars"],
              ].map(([repo, stars]) => (
                <div key={repo}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-mono text-[11px] font-semibold">{repo}</span>
                    <span className="shrink-0 font-mono text-[10px] text-subtle">{stars}</span>
                  </div>
                  <Lines widths={["92%", "64%"]} />
                </div>
              ))}
            </div>
          </CardShell>

          {/* Front: the issue itself */}
          <CardShell style={place(-150, -160, 40, 0, 0, 0.05)} className="w-[340px]">
            <div className="flex items-center justify-between bg-fg px-5 py-3.5 dark:bg-surface-sunken">
              <span className="text-[15px] font-bold tracking-tight text-bg dark:text-fg">
                Devlr<span className="text-accent-fill">.</span>
              </span>
              <span className="font-mono text-[10px] text-subtle">Thu, Oct 1</span>
            </div>
            <div className="p-5">
              <Label>top story</Label>
              <p className="mt-2.5 text-[16px] font-semibold leading-snug tracking-tight">
                Postgres 18 ships asynchronous I/O
              </p>
              <p className="mt-1.5 font-mono text-[10px] text-subtle">postgresql.org · 412 points on HN</p>
              <Lines widths={["100%", "96%", "72%"]} />
              <p className="mt-3 font-mono text-[10px] text-subtle">[+] more like this&nbsp;&nbsp;[-] less like this</p>

              <div className="mt-4 border-t border-line pt-3.5">
                <Label>news</Label>
                <p className="mt-2 text-[13px] font-semibold leading-snug">Node.js 22.23.3 fixes an HTTP parser leak</p>
                <Lines widths={["94%", "58%"]} />
              </div>
            </div>
          </CardShell>

          {/* Front right: the terminal chip */}
          <CardShell style={place(70, 150, 170, -6, 0, 0.55)} className="w-[268px] whitespace-nowrap !bg-fg px-4 py-3 dark:!bg-surface-sunken">
            <p className="font-mono text-[11px] text-bg dark:text-fg">
              <span className="text-accent-fill">$</span> devlr read --today
              <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-blink bg-accent-fill" />
            </p>
            <p className="mt-1.5 font-mono text-[10px] text-subtle">8 stories · 0 repeats · 121 sources</p>
          </CardShell>
        </div>
      </div>
    </div>
  );
}
