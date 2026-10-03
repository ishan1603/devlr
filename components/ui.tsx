import * as React from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------- Button -- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap " +
  "transition-[background-color,border-color,color,opacity,transform] duration-150 " +
  "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-fill text-on-accent hover:bg-accent-fill-hover",
  secondary: "border border-line bg-surface text-fg hover:border-line-strong hover:bg-surface-sunken",
  ghost: "text-muted hover:bg-surface-sunken hover:text-fg",
  danger: "border border-line bg-surface text-danger hover:bg-danger-soft",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

/** Shared so a <Link> can look exactly like a <Button>. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button className={buttonClass(variant, size, className)} disabled={disabled || loading} {...props}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Card -- */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-xl border border-line bg-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------------------------------------------- Badge -- */

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-medium",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- Forms -- */

const FIELD =
  "h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg " +
  "placeholder:text-subtle transition-colors focus:border-accent focus:outline-none";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(FIELD, className)} {...props} />;
}

/**
 * The native control with its arrow redrawn, so it matches the other fields
 * and still opens the platform picker (which is the right UI on a phone).
 * `className` sizes the wrapper: the select always fills it.
 */
export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx("relative block", className)}>
      <select className={cx(FIELD, "cursor-pointer appearance-none pr-9")} {...props}>
        {children}
      </select>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx("block text-[13px] font-medium text-fg", className)} {...props} />;
}

/**
 * A real checkbox underneath, so it is keyboard and screen-reader accessible
 * for free. The visible track is a sibling styled off the input's state.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={cx("relative inline-flex shrink-0 cursor-pointer", disabled && "cursor-not-allowed opacity-50")}>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className={cx(
          "h-6 w-10 rounded-full border border-line bg-surface-sunken transition-colors",
          "peer-checked:border-transparent peer-checked:bg-accent-fill",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
        )}
      />
      <span
        className={cx(
          "pointer-events-none absolute left-[3px] top-[3px] size-[18px] rounded-full bg-subtle transition-transform",
          "peer-checked:translate-x-4 peer-checked:bg-on-accent"
        )}
      />
    </label>
  );
}

/** A selectable pill: topics, stack items, options. */
export function Chip({
  selected,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium",
        "transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]",
        selected
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------- Utilities -- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-surface-sunken", className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** `// label`: the section marker used across the site and the emails. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cx("font-mono text-[12px] tracking-wide", className)}>
      <span className="text-subtle">{"// "}</span>
      <span className="text-accent">{children}</span>
    </p>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("text-[20px] font-bold leading-none tracking-tight", className)}>
      Devlr<span className="text-accent">.</span>
    </span>
  );
}

/** Page shell: one place that owns max width and horizontal rhythm. */
export function Page({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-10 relative animate-in fade-in slide-in-from-bottom-4 duration-500", className)} {...props}>
      {/* Decorative Interactive Graphic */}
      <div className="absolute right-8 top-8 hidden lg:block -z-10 [perspective:1000px]">
        <div className="relative group cursor-pointer w-16 h-16 [transform-style:preserve-3d] transition-all duration-700 ease-out hover:[transform:rotateX(25deg)_rotateY(-25deg)_scale(1.1)]">
          <div className="absolute inset-0 bg-accent/20 blur-xl rounded-full scale-50 group-hover:scale-150 transition-transform duration-700 ease-out" />
          <svg 
            className="w-full h-full text-accent/30 group-hover:text-accent transition-all duration-500 ease-out group-hover:[transform:translateZ(20px)] drop-shadow-xl" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="1.5"
          >
            <path d="M12 2L2 22h20L12 2z" strokeLinejoin="round" />
            <circle cx="12" cy="14" r="3" />
            <path d="M12 2v20" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" />
          </svg>
        </div>
      </div>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-xl text-[15px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
