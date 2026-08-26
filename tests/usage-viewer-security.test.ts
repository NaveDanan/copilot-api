import { describe, expect, test } from "bun:test"

import {
  createUsageViewerContentSecurityPolicy,
  usageViewerContentSecurityPolicy,
  usageViewerCss,
  usageViewerHtml,
} from "~/usage-viewer"

describe("usage viewer security", () => {
  test("ships no third-party runtime resources", () => {
    expect(usageViewerHtml).not.toMatch(/(?:src|href)=["']https?:\/\//i)
    expect(usageViewerHtml).toContain('href="/usage-viewer/usage-viewer.css"')
    expect(usageViewerCss.length).toBeGreaterThan(1_000)
  })

  test("restricts requests and API keys to the gateway origin", () => {
    expect(usageViewerHtml).toContain("url.origin !== window.location.origin")
    expect(usageViewerHtml).toContain('redirect: "error"')
    expect(usageViewerHtml).toContain("Ignored unsafe Usage Viewer endpoint:")
    expect(usageViewerHtml).not.toContain(
      "endpointUrlInput.value = endpointFromUrl",
    )
    expect(usageViewerHtml).toContain(
      "window.sessionStorage.setItem(storageKey, value)",
    )
    expect(usageViewerHtml).not.toContain(
      "window.localStorage.setItem(storageKey, value)",
    )
  })

  test("coerces and escapes quota values before HTML rendering", () => {
    expect(usageViewerHtml).toContain(
      "const entitlementValue = Number(entitlement)",
    )
    expect(usageViewerHtml).toContain(
      "<span>${escapeHtml(used)} / ${escapeHtml(entitlementText)}</span>",
    )
    expect(usageViewerHtml).toContain(
      "<span>${escapeHtml(remainingText)} remaining</span>",
    )
    expect(usageViewerHtml).not.toContain("entitlement.toLocaleString()")
    expect(usageViewerHtml).not.toContain("remaining.toLocaleString()")
  })

  test("pins the only inline script with CSP and denies exfiltration sinks", () => {
    expect(createUsageViewerContentSecurityPolicy(usageViewerHtml)).toBe(
      usageViewerContentSecurityPolicy,
    )
    expect(usageViewerContentSecurityPolicy).toContain("default-src 'none'")
    expect(usageViewerContentSecurityPolicy).toMatch(
      /script-src 'sha256-[A-Za-z0-9+/=]+'/,
    )
    expect(usageViewerContentSecurityPolicy).toContain("connect-src 'self'")
    expect(usageViewerContentSecurityPolicy).toContain("frame-ancestors 'none'")
  })

  test("rejects missing or additional inline scripts when creating CSP", () => {
    expect(() =>
      createUsageViewerContentSecurityPolicy("<html></html>"),
    ).toThrow("exactly one inline script")
    expect(() =>
      createUsageViewerContentSecurityPolicy(
        "<script>one</script><script>two</script>",
      ),
    ).toThrow("exactly one inline script")
  })
})
