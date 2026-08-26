import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  createZstdDecompressionMiddleware,
  legacyZstdDecompressionMiddleware,
  zstdDecompressionMiddleware,
} from "~/lib/zstd-request"

const createApp = (
  options?: Parameters<typeof createZstdDecompressionMiddleware>[0],
) => {
  const app = new Hono()

  app.use(
    options ?
      createZstdDecompressionMiddleware(options)
    : zstdDecompressionMiddleware,
  )
  app.post("/echo", async (c) =>
    c.json({
      contentEncoding: c.req.header("content-encoding") ?? null,
      contentLength: c.req.raw.headers.get("content-length"),
      payload: await c.req.json(),
    }),
  )

  return app
}

describe("zstd request middleware", () => {
  test("decompresses zstd encoded json request bodies", async () => {
    const app = createApp()
    const payload = { model: "gpt-5", messages: [{ role: "user" }] }
    const body = await Bun.zstdCompress(JSON.stringify(payload))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      contentEncoding: null,
      contentLength: null,
      payload,
    })
  })

  test("leaves unencoded request bodies unchanged", async () => {
    const app = createApp()
    const payload = { ok: true }

    const response = await app.request("/echo", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ payload })
  })

  test("keeps the legacy decoder available for compatibility mode", async () => {
    const app = new Hono()
    app.use(legacyZstdDecompressionMiddleware)
    app.post("/echo", async (c) => c.json(await c.req.json()))
    const payload = { compatible: true }
    const body = await Bun.zstdCompress(JSON.stringify(payload))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
  })

  test("rejects invalid zstd request bodies", async () => {
    const app = createApp()

    const response = await app.request("/echo", {
      body: "not-zstd",
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Failed to decompress zstd request body.",
        type: "invalid_request_error",
      },
    })
  })

  test("rejects compressed request bodies over the configured limit", async () => {
    const body = await Bun.zstdCompress(JSON.stringify({ ok: true }))
    const app = createApp({
      maxCompressedBytes: body.byteLength - 1,
      maxDecompressedBytes: 1024,
    })

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: {
        message: "Zstd request body exceeds the configured size limit.",
        type: "invalid_request_error",
      },
    })
  })

  test("rejects decompressed request bodies over the configured limit", async () => {
    const body = await Bun.zstdCompress(
      JSON.stringify({ value: "a".repeat(1024) }),
    )
    const app = createApp({
      maxCompressedBytes: 1024,
      maxDecompressedBytes: 128,
    })

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: {
        message: "Zstd request body exceeds the configured size limit.",
        type: "invalid_request_error",
      },
    })
  })

  test("rejects frames that request a window over the configured limit", async () => {
    const app = createApp({
      maxCompressedBytes: 1024,
      maxDecompressedBytes: 1024,
    })
    const body = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x88])

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
  })
})
