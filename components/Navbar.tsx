"use client";

import { useAuth } from "@/contexts/AuthContext";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import { Button, cx } from "@/components/ui";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/select", label: "Topics" },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("font-serif text-[22px] leading-none tracking-tight", className)}>
      Sendlr<span className="text-accent">.</span>
    </span>
  );
}

export default function Navbar() {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  if (!user) return null;

  async function handleLogout() {
    await signOut();
    router.push("/signin");
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-6 px-5 sm:px-8">
        <Link href="/dashboard" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                  active ? "bg-surface-sunken text-fg" : "text-muted hover:text-fg"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* The address matters (it is where newsletters land) but should not
              dominate the bar, so it is muted and hidden on small screens. */}
          <span className="hidden text-[13px] text-muted sm:inline" title={user.email}>
            {user.email}
          </span>
          <ThemeToggle />
          <Button variant="secondary" size="sm" onClick={handleLogout}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
