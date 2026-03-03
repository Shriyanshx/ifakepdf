import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "ifakepdf – AI PDF Editor",
  description:
    "Draw a bounding box on any PDF region, let AI generate a signature, seal or handwriting, and insert it seamlessly.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased min-h-screen bg-[#0f1117]">
        {children}
      </body>
    </html>
  );
}
