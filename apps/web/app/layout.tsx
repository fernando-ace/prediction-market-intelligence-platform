import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prediction Market Scanner",
  description: "Read-only prediction market opportunity scanner and paper trading dashboard"
};

const navItems = [
  { href: "/", label: "Home" },
  { href: "/markets", label: "Live Markets" },
  { href: "/snapshot-inspector", label: "Snapshot Inspector" },
  { href: "/related-groups", label: "Related Groups" },
  { href: "/signals", label: "Signals" },
  { href: "/paper-trades", label: "Paper Trades" },
  { href: "/logs", label: "Logs" },
  { href: "/api/export.csv", label: "Export CSV" }
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <Link href="/" className="text-lg font-semibold tracking-normal text-ink">
              Prediction Market Scanner
            </Link>
            <nav className="flex flex-wrap gap-2 text-sm">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded border border-line px-3 py-1.5 text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>
      </body>
    </html>
  );
}
