"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * The theme lives on <html> as a class, set before first paint by the inline
 * script in the root layout. This component reads it from there rather than
 * keeping its own copy, so it can never disagree with what is painted.
 *
 * useSyncExternalStore is the right tool: the DOM is the store. It also covers
 * the server render, where there is no DOM and the answer is "not known yet".
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const getSnapshot = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
const getServerSnapshot = () => null;

export default function ThemeToggle() {
  const theme = useSyncExternalStore<"dark" | "light" | null>(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Private browsing can throw on write. The toggle still works for this
      // page view, it just will not be remembered.
    }
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme ? `Switch to ${theme === "dark" ? "light" : "dark"} theme` : "Switch theme"}
      className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-surface-sunken hover:text-fg"
    >
      {/* A stable placeholder until the theme is known, so server and client
          markup agree. */}
      {theme === null ? (
        <span className="size-4" />
      ) : theme === "dark" ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </button>
  );
}
