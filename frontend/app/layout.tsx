import "./globals.css";
import type { Metadata } from "next";
import { Fira_Sans, JetBrains_Mono } from "next/font/google";
import AppShell from "@/components/AppShell";
import { Providers } from "./providers";
import { THEME_BOOT_SCRIPT } from "@/lib/themeScript";

const fira = Fira_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "800", "900"],
  variable: "--font-fira",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Finance Hub",
  description: "Every statement, one calm picture.",
};

export default function RootLayout({
  children,
}: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" className={`${fira.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-ink antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
