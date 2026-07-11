import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "SceneFlow AI — Xưởng video tự động";
const description =
  "Tạo storyboard, tối ưu prompt, xếp hàng Veo và ghép video dài có tính liên kết trong một Studio duy nhất.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const directHost = requestHeaders.get("host")?.trim();
  const candidate = forwardedHost || directHost || "localhost";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidate) ? candidate : "localhost";
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : host.startsWith("localhost")
      ? "http"
      : "https";
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title,
    description,
    applicationName: "SceneFlow AI",
    openGraph: {
      type: "website",
      locale: "vi_VN",
      title,
      description,
      siteName: "SceneFlow AI",
      images: [{ url: "/og.png", width: 1731, height: 909, alt: "SceneFlow AI — Xưởng video tự động" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
