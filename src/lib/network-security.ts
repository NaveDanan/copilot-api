import type { MiddlewareHandler } from "hono"
import { isIP } from "node:net"

import { getConfiguredApiKeys } from "./request-auth"

export const DEFAULT_SERVER_HOST = "127.0.0.1"

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname)
  if (normalizedHostname === "localhost" || normalizedHostname === "::1") {
    return true
  }

  return (
    isIP(normalizedHostname) === 4
    && normalizedHostname.split(".", 1)[0] === "127"
  )
}

export function assertSafeServerBinding(
  hostname: string,
  apiKeys: Array<string>,
): void {
  if (!hostname.trim()) {
    throw new Error("Server host cannot be empty")
  }

  if (!isLoopbackHostname(hostname) && apiKeys.length === 0) {
    throw new Error(
      `Refusing to bind to non-loopback host "${hostname}" without auth.apiKeys. Configure at least one API key before allowing remote access.`,
    )
  }
}

export function assertSafeServerTransport(
  hostname: string,
  tlsEnabled: boolean,
  allowInsecureHttp: boolean,
): void {
  if (!isLoopbackHostname(hostname) && !tlsEnabled && !allowInsecureHttp) {
    throw new Error(
      `Refusing to serve non-loopback host "${hostname}" over plaintext HTTP. Configure --tls-cert and --tls-key, or explicitly accept credential and chat exposure with --allow-insecure-http.`,
    )
  }
}

export function formatServerUrl(
  hostname: string,
  port: number,
  tlsEnabled = false,
): string {
  const normalizedHostname = normalizeHostname(hostname)
  const displayHostname =
    normalizedHostname === "0.0.0.0" || normalizedHostname === "::" ?
      "localhost"
    : normalizedHostname
  const urlHostname =
    isIP(displayHostname) === 6 ? `[${displayHostname}]` : displayHostname

  return `${tlsEnabled ? "https" : "http"}://${urlHostname}:${port}`
}

function getRequestHostname(
  requestUrl: string,
  hostHeader: string | undefined,
): string | null {
  try {
    return hostHeader ?
        new URL(`http://${hostHeader}`).hostname
      : new URL(requestUrl).hostname
  } catch {
    return null
  }
}

function getRequestOrigin(
  requestUrl: string,
  hostHeader: string | undefined,
  forwardedProtoHeader: string | undefined,
): string | null {
  try {
    const url = new URL(requestUrl)
    const forwardedProto = forwardedProtoHeader
      ?.split(",", 1)[0]
      ?.trim()
      .toLowerCase()
    const protocol =
      forwardedProto === "http" || forwardedProto === "https" ?
        `${forwardedProto}:`
      : url.protocol
    return new URL(`${protocol}//${hostHeader ?? url.host}`).origin
  } catch {
    return null
  }
}

interface HostValidationMiddlewareOptions {
  getApiKeys?: () => Array<string>
}

export function createHostValidationMiddleware(
  options: HostValidationMiddlewareOptions = {},
): MiddlewareHandler {
  const getApiKeys = options.getApiKeys ?? getConfiguredApiKeys

  return async (c, next) => {
    if (getApiKeys().length > 0) {
      return next()
    }

    const hostname = getRequestHostname(c.req.url, c.req.header("host"))
    if (!hostname || !isLoopbackHostname(hostname)) {
      return c.json(
        {
          error: {
            message:
              "Requests must use a loopback host unless API authentication is configured",
            type: "invalid_host",
          },
        },
        421,
      )
    }

    return next()
  }
}

export const browserIsolationMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  const origin = c.req.header("origin")
  if (origin) {
    const requestOrigin = getRequestOrigin(
      c.req.url,
      c.req.header("host"),
      c.req.header("x-forwarded-proto"),
    )
    let parsedOrigin: string | null = null

    try {
      parsedOrigin = origin === "null" ? null : new URL(origin).origin
    } catch {
      parsedOrigin = null
    }

    if (!requestOrigin || !parsedOrigin || requestOrigin !== parsedOrigin) {
      return c.json(
        {
          error: {
            message: "Cross-origin browser requests are not allowed",
            type: "invalid_origin",
          },
        },
        403,
      )
    }
  }

  await next()

  const browserAccessHeaders = [...c.res.headers.keys()].filter(
    (headerName) =>
      headerName.startsWith("access-control-")
      || headerName === "timing-allow-origin",
  )
  for (const headerName of browserAccessHeaders) {
    c.header(headerName, undefined)
  }

  return
}
