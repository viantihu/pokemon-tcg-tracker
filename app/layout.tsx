import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Binder Ops · Pokémon TCG Binder",
  description: "Routes each card to a binder and half, and tracks evolution line state.",
  applicationName: "TCG Binder",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "TCG Binder",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

// themeColor must live on `viewport`, not `metadata` (Next 16 — see
// node_modules/next/dist/docs .../generate-viewport.md). Olive matches --olive.
export const viewport: Viewport = {
  themeColor: "#6d7b3c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
