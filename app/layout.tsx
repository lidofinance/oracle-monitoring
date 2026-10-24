import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import SectionJump from "./section-jump";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;

  return {
    title: {
      default: "Lido Oracle Watch",
      template: "%s · Lido Oracle Watch",
    },
    description:
      "Live onchain participation and DataBus telemetry for Lido Oracle operators across Mainnet and Hoodi.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Lido Oracle Watch",
      description: "Onchain operations console for Mainnet and Hoodi.",
      type: "website",
      images: [{ url: image, width: 1730, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Lido Oracle Watch",
      description: "Onchain operations console for Mainnet and Hoodi.",
      images: [image],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <SectionJump />
        {children}
      </body>
    </html>
  );
}
