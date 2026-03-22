import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ 
  subsets: ["latin"],
  variable: '--font-inter',
});

const playfair = Playfair_Display({ 
  subsets: ["latin"],
  variable: '--font-playfair',
});

const jetbrainsMono = JetBrains_Mono({ 
  subsets: ["latin"],
  variable: '--font-mono',
});

export const viewport: Viewport = {
  themeColor: "#020202", // Lunarpunk base default
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "The Obscurity Engine",
  description: "Bioluminescent discovery for the sonically adventurous.",
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${playfair.variable} ${jetbrainsMono.variable} font-sans bg-[#fcfaf6] dark:bg-[#020202] text-neutral-800 dark:text-cyan-50 antialiased min-h-screen selection:bg-lime-100 dark:selection:bg-cyan-950 transition-colors duration-1000`}>
        {/* Solarpunk Glow (Light) / Lunarpunk Bioluminescence (Dark) */}
        <div className="fixed inset-0 bg-[radial-gradient(circle_at_50%_-20%,_rgba(16,185,129,0.06)_0%,_transparent_70%)] dark:bg-[radial-gradient(circle_at_50%_-20%,_rgba(6,182,212,0.1)_0%,_transparent_70%)] pointer-events-none" />
        <div className="fixed inset-0 bg-[radial-gradient(circle_at_0%_100%,_rgba(251,191,36,0.03)_0%,_transparent_40%)] dark:bg-[radial-gradient(circle_at_0%_100%,_rgba(139,92,246,0.05)_0%,_transparent_40%)] pointer-events-none" />
        <main className="relative z-10">
          {children}
        </main>
      </body>
    </html>
  );
}
