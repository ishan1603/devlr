"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  CalendarClock,
  GraduationCap,
  Home,
  Inbox,
  LogOut,
  Settings,
  ShieldCheck,
  Tags,
  type LucideIcon,
} from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import { Badge, Wordmark, cx } from "@/components/ui";
import { signOut } from "@/lib/sign-out";

interface NavItem {
  /** Path under the shell's base, "" for the home screen. */
  path: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { path: "", label: "Home", icon: Home },
  { path: "/repos", label: "Repos", icon: ShieldCheck },
  { path: "/topics", label: "Topics", icon: Tags },
  { path: "/schedule", label: "Schedule", icon: CalendarClock },
  { path: "/issues", label: "Issues", icon: Inbox },
  { path: "/learn", label: "Learn", icon: GraduationCap },
  { path: "/companies", label: "Companies", icon: Building2 },
  { path: "/settings", label: "Settings", icon: Settings },
];

/** Shown so the product's direction is visible, without pretending they work. */
const UPCOMING: { label: string; icon: LucideIcon }[] = [];

function isActive(pathname: string, href: string, isHome: boolean): boolean {
  return isHome ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppShell({
  email,
  paused,
  basePath = "/app",
  children,
}: {
  email: string;
  paused: boolean;
  /** Where this shell is mounted. /demo/app reuses it with mock data. */
  basePath?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = NAV.map((item) => ({ ...item, href: `${basePath}${item.path}`, isHome: item.path === "" }));

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-dvh lg:pl-60">
      {/* Sidebar: desktop only. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href={basePath} aria-label="Devlr home">
            <Wordmark />
          </Link>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2" aria-label="Main">
          {nav.map((item) => {
            const active = isActive(pathname, item.href, item.isHome);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors",
                  active ? "bg-surface-sunken text-fg" : "text-muted hover:bg-surface-sunken hover:text-fg"
                )}
              >
                <item.icon className={cx("size-4", active && "text-accent")} />
                {item.label}
              </Link>
            );
          })}

          <p className="px-3 pb-1 pt-6 font-mono text-[11px] text-subtle">{"// coming"}</p>
          {UPCOMING.map((item) => (
            <div
              key={item.label}
              className="flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] font-medium text-subtle"
            >
              <item.icon className="size-4" />
              {item.label}
              <Badge className="ml-auto">Soon</Badge>
            </div>
          ))}
        </nav>

        <div className="border-t border-line p-3">
          <p className="truncate px-3 pb-2 font-mono text-[12px] text-subtle" title={email}>
            {email}
          </p>
          <div className="flex items-center gap-2 px-1">
            <ThemeToggle />
            <button
              onClick={handleSignOut}
              className="flex h-9 flex-1 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-muted transition-colors hover:bg-surface-sunken hover:text-fg"
            >
              <LogOut className="size-4" />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Top bar: phones and tablets. */}
      <header className="sticky top-0 z-30 flex h-14 items-center border-b border-line bg-bg/85 px-5 backdrop-blur-md lg:hidden">
        <Link href={basePath} aria-label="Devlr home">
          <Wordmark className="text-[18px]" />
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            className="grid size-9 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-surface-sunken hover:text-fg"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </header>

      {paused && (
        <div className="border-b border-line bg-warning-soft px-5 py-2.5 text-center text-[13px] text-warning">
          Email is paused. Nothing will be sent until you{" "}
          <Link href={`${basePath}/schedule`} className="font-medium underline">
            resume it
          </Link>
          .
        </div>
      )}

      {/* Bottom padding keeps content clear of the tab bar on small screens. */}
      <main className="pb-24 lg:pb-0">{children}</main>

      {/* Tab bar: phones and tablets. Six targets, still 53px each on the narrowest phone. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
      >
        <div className="mx-auto flex max-w-lg overflow-x-auto overflow-y-hidden">
          {nav.map((item) => {
            const active = isActive(pathname, item.href, item.isHome);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-16 min-w-[64px] flex-1 shrink-0 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                  active ? "text-accent" : "text-subtle hover:text-fg"
                )}
              >
                <item.icon className="size-5" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
