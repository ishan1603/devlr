/**
 * The hero graphic: a small stack of newspaper sheets that appear to typeset
 * themselves, then drift.
 *
 * Built from divs rather than an illustration so it inherits the theme tokens —
 * the paper is `--surface`, so it reads as newsprint in light mode and as a lit
 * sheet against near-black in dark mode, with no second asset to maintain.
 *
 * Purely decorative, hence aria-hidden: a screen reader announcing a dozen
 * empty rules would be noise, and the headline beside it carries the meaning.
 */

/** Widths chosen to look like ragged-right body copy rather than a blocked grid. */
const COLUMN_A = [96, 78, 88, 62, 92, 70, 84];
const COLUMN_B = [88, 94, 66, 90, 74, 96, 58];

function Line({ width, delay }: { width: number; delay: number }) {
  return (
    <span
      className="hero-line block h-[5px] rounded-full bg-line"
      style={{ width: `${width}%`, animationDelay: `${delay}ms` }}
    />
  );
}

function Column({ widths, offset }: { widths: number[]; offset: number }) {
  return (
    <div className="flex flex-1 flex-col gap-[7px]">
      {widths.map((w, i) => (
        <Line key={i} width={w} delay={offset + i * 70} />
      ))}
    </div>
  );
}

export default function HeroNewspaper() {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto aspect-square w-full max-w-[420px] select-none"
    >
      {/* Warm glow behind the stack, so the sheets sit in light rather than
          floating on a flat background. */}
      <div
        className="absolute left-1/2 top-1/2 size-[92%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(circle, var(--accent-soft), transparent 70%)" }}
      />

      {/* Back sheets: rotation is passed as --tilt so the float keyframes can
          preserve it instead of snapping the sheet upright mid-animation. */}
      <div
        className="hero-sheet absolute inset-x-8 top-10 h-[78%] rounded-xl border border-line bg-surface/70 shadow-card"
        style={{ ["--tilt" as string]: "-7deg", animationDelay: "0ms, 0.7s" }}
      />
      <div
        className="hero-sheet absolute inset-x-6 top-7 h-[80%] rounded-xl border border-line bg-surface/85 shadow-card"
        style={{ ["--tilt" as string]: "-3.5deg", animationDelay: "90ms, 0.9s" }}
      />

      {/* Front sheet */}
      <div
        className="hero-sheet absolute inset-x-3 top-3 flex h-[84%] flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-pop"
        style={{ ["--tilt" as string]: "1.5deg", animationDelay: "180ms, 1.1s" }}
      >
        <div className="flex items-baseline justify-between border-b border-line pb-2.5">
          <span className="font-serif text-[19px] leading-none tracking-tight">
            Sendlr<span className="text-accent">.</span>
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-subtle">
            Today
          </span>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span
              className="hero-line block h-[9px] w-[82%] rounded bg-fg/85"
              style={{ animationDelay: "420ms" }}
            />
            <span className="hero-cursor block h-[11px] w-[2px] bg-accent" />
          </div>
          <Line width={54} delay={520} />
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-accent">
            Technology
          </span>
          <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-subtle">
            Business
          </span>
        </div>

        <div className="flex flex-1 gap-4 pt-0.5">
          <Column widths={COLUMN_A} offset={620} />
          <Column widths={COLUMN_B} offset={700} />
        </div>
      </div>

      {/* "Delivered" chip, arriving last — the payoff of the sequence. */}
      <div
        className="hero-sheet absolute -bottom-1 right-0 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-pop"
        style={{ ["--tilt" as string]: "-2deg", animationDelay: "1.25s, 1.9s" }}
      >
        <span className="grid size-5 place-items-center rounded-full bg-success-soft">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="size-3 text-success">
            <path d="M5 12l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="text-[12px] font-medium">Delivered 7:00 AM</span>
      </div>
    </div>
  );
}
