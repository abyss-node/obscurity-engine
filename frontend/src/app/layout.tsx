import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({ 
  subsets: ["latin"],
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: "ObscurityEngine",
  description: "Terminal aesthetics frontend",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${jetbrainsMono.variable} font-mono bg-background text-foreground antialiased min-h-screen p-8`}>
        <div className="max-w-4xl mx-auto border border-foreground/30 p-6 rounded shadow-[0_0_15px_rgba(16,185,129,0.2)]">
          <header className="mb-8 border-b border-foreground/30 pb-4">
            <h1 className="text-2xl font-bold tracking-tight">&gt; _ObscurityEngine</h1>
          </header>
          <main>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
