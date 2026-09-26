import type { Metadata, Viewport } from "next";
import Providers from "./Providers";

export const metadata: Metadata = {
  title: "hearthkeeper",
  description:
    "A living-room collaborative storytelling game — an LLM game master narrates; the table tells the story.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
