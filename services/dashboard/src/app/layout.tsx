import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NoKYC-GasStation - ERC-4337 Paymaster Dashboard",
  description: "Real-time monitoring of ERC-4337 paymaster operations, gas reserves, and transaction metrics for NoKYC-GasStation",
  keywords: ["ERC-4337", "paymaster", "gas station", "blockchain", "polygon", "user operations"],
  authors: [{ name: "NoKYC-GasStation" }],
  viewport: "width=device-width, initial-scale=1",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-dark-bg text-zinc-100">{children}</body>
    </html>
  );
}
