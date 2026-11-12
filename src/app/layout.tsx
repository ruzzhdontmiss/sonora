import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SONORA | Universal Music Library & Portability Platform",
  description: "Provider-independent music library, playlist management, and portability platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#090a0f] text-gray-100 antialiased selection:bg-indigo-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
