import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";
import "./components.css";

export const metadata: Metadata = {
  title: {
    default: "Org OS",
    template: "%s · Org OS",
  },
  description: "Internal production foundation for the esports organization operating system.",
  robots: {
    index: false,
    follow: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#090b0d",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonce-based CSP requires dynamic rendering so Next can attach the per-request nonce.
  await connection();

  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
