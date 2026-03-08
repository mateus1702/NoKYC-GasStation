import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project4 AA Dashboard",
  description: "Monitor paymaster and worker metrics",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-dark-bg text-zinc-100">{children}</body>
    </html>
  );
}
