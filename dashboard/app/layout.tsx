import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth";
import { Toasts } from "@/components/ui";
import "./globals.css";

export const metadata: Metadata = { title: "AdForge", description: "Contextual advertising asset management" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans"><Toasts><AuthProvider>{children}</AuthProvider></Toasts></body>
    </html>
  );
}
