import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  assertSafeServerBinding,
  assertSafeServerTransport,
  browserIsolationMiddleware,
  createHostValidationMiddleware,
  formatServerUrl,
  isLoopbackHostname,
} from "~/lib/network-security"

describe("network security", () => {
  test("recognizes only loopback hostnames and addresses", () => {
    expect(isLoopbackHostname("localhost")).toBeTrue()
    expect(isLoopbackHostname("LOCALHOST.")).toBeTrue()
    expect(isLoopbackHostname("127.0.0.1")).toBeTrue()
    expect(isLoopbackHostname("127.99.1.2")).toBeTrue()
    expect(isLoopbackHostname("::1")).toBeTrue()
    expect(isLoopbackHostname("[::1]")).toBeTrue()

    expect(isLoopbackHostname("0.0.0.0")).toBeFalse()
    expect(isLoopbackHostname("::")).toBeFalse()
    expect(isLoopbackHostname("192.168.1.2")).toBeFalse()
    expect(isLoopbackHostname("localhost.example.com")).toBeFalse()
  })

  test("requires authentication before binding beyond loopback", () => {
    expect(() => assertSafeServerBinding("127.0.0.1", [])).not.toThrow()
    expect(() => assertSafeServerBinding("0.0.0.0", ["secret"])).not.toThrow()
    expect(() => assertSafeServerBinding("", ["secret"])).toThrow(
      "Server host cannot be empty",
    )
    expect(() => assertSafeServerBinding("0.0.0.0", [])).toThrow(
      "without auth.apiKeys",
    )
  })

  test("requires TLS or explicit insecure HTTP opt-in beyond loopback", () => {
    expect(() =>
      assertSafeServerTransport("127.0.0.1", false, false),
    ).not.toThrow()
    expect(() =>
      assertSafeServerTransport("0.0.0.0", true, false),
    ).not.toThrow()
    expect(() =>
      assertSafeServerTransport("0.0.0.0", false, true),
    ).not.toThrow()
    expect(() => assertSafeServerTransport("0.0.0.0", false, false)).toThrow(
      "--allow-insecure-http",
    )
  })

  test("formats reachable local URLs without advertising wildcard hosts", () => {
    expect(formatServerUrl("127.0.0.1", 4141)).toBe("http://127.0.0.1:4141")
    expect(formatServerUrl("0.0.0.0", 4141)).toBe("http://localhost:4141")
    expect(formatServerUrl("::1", 4141)).toBe("http://[::1]:4141")
    expect(formatServerUrl("0.0.0.0", 4141, true)).toBe(
      "https://localhost:4141",
    )
  })

  test("rejects DNS-rebinding hosts when regular API keys are absent", async () => {
    let apiKeys: Array<string> = []
    const app = new Hono()
    app.use(
      createHostValidationMiddleware({
        getApiKeys: () => apiKeys,
      }),
    )
    app.get("/", (c) => c.json({ ok: true }))

    expect((await app.request("http://localhost/")).status).toBe(200)
    expect((await app.request("http://127.0.0.1/")).status).toBe(200)
    expect((await app.request("http://attacker.example/")).status).toBe(421)

    apiKeys = ["configured"]
    expect((await app.request("http://gateway.example/")).status).toBe(200)
  })

  test("rejects cross-origin browsers and strips upstream CORS headers", async () => {
    const app = new Hono()
    app.use(browserIsolationMiddleware)
    app.get("/", (c) => {
      c.header("Access-Control-Allow-Origin", "*")
      c.header("Access-Control-Allow-Credentials", "true")
      c.header("Timing-Allow-Origin", "*")
      return c.json({ ok: true })
    })

    const crossOriginResponse = await app.request("http://localhost/", {
      headers: {
        origin: "https://attacker.example",
      },
    })
    expect(crossOriginResponse.status).toBe(403)

    const sameOriginResponse = await app.request("http://localhost/", {
      headers: {
        origin: "http://localhost",
      },
    })
    expect(sameOriginResponse.status).toBe(200)
    expect(
      sameOriginResponse.headers.get("access-control-allow-origin"),
    ).toBeNull()
    expect(
      sameOriginResponse.headers.get("access-control-allow-credentials"),
    ).toBeNull()
    expect(sameOriginResponse.headers.get("timing-allow-origin")).toBeNull()

    const forwardedHttpsResponse = await app.request(
      "http://gateway.example/",
      {
        headers: {
          host: "gateway.example",
          origin: "https://gateway.example",
          "x-forwarded-proto": "https",
        },
      },
    )
    expect(forwardedHttpsResponse.status).toBe(200)
  })
})
