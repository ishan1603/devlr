import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { NotificationProvider } from "@/contexts/NotificationContext";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://devlr.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: "Devlr. The developer inbox",
    template: "%s | Devlr",
  },
  description:
    "Dev news for your stack, end-of-life warnings for what you run, and the repos worth knowing about. One email, on your schedule.",
  openGraph: {
    title: "Devlr. The developer inbox",
    description:
      "Dev news for your stack, end-of-life warnings for what you run, and the repos worth knowing about. One email, on your schedule.",
    type: "website",
    siteName: "Devlr",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf7" },
  ],
  width: "device-width",
  initialScale: 1,
};

/**
 * Applied before first paint so the page never flashes one theme and swaps to
 * the other. Kept inline and dependency-free for the same reason: anything
 * loaded as a module would run too late.
 *
 * Dark is the default. Light is used only when the visitor has chosen it.
 */
const themeScript = `
(function () {
  try {
    if (localStorage.getItem("theme") !== "light") {
      document.documentElement.classList.add("dark");
    }
  } catch (e) {
    document.documentElement.classList.add("dark");
  }
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <NotificationProvider>
          <AuthProvider>{children}</AuthProvider>
        </NotificationProvider>
      </body>
    </html>
  );
}
