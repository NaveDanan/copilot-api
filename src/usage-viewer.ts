import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const usageViewerFileUrl = new URL("../pages/index.html", import.meta.url)
const usageViewerCssFileUrl = new URL(
  "../pages/usage-viewer.css",
  import.meta.url,
)

export const usageViewerHtml = readFileSync(usageViewerFileUrl, "utf8")
export const usageViewerCss = readFileSync(usageViewerCssFileUrl, "utf8")

export function createUsageViewerContentSecurityPolicy(html: string): string {
  const inlineScripts = [
    ...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi),
  ]
  if (inlineScripts.length !== 1 || inlineScripts[0]?.[1] === undefined) {
    throw new Error("Usage Viewer must contain exactly one inline script")
  }

  const scriptHash = createHash("sha256")
    .update(inlineScripts[0][1])
    .digest("base64")

  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
  ].join("; ")
}

export const usageViewerContentSecurityPolicy =
  createUsageViewerContentSecurityPolicy(usageViewerHtml)
