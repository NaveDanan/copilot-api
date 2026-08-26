import { describe, expect, test } from "bun:test"

import {
  getInsecureProviderWarning,
  inspectProviderBaseUrl,
  resolveProviderAuthType,
  type ResolvedProviderConfig,
} from "~/lib/config"

import { buildProviderUpstreamHeaders } from "~/services/providers/provider-proxy"

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "custom",
    type: "anthropic",
    baseUrl: "https://example.com",
    apiKey: "provider-key",
    authType: "x-api-key",
    ...overrides,
  }
}

describe("buildProviderUpstreamHeaders", () => {
  test("uses x-api-key auth by default", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig(),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "provider-key",
      "anthropic-version": "2023-06-01",
    })
  })

  test("uses Authorization bearer auth when configured", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ authType: "authorization" }),
      new Headers({
        accept: "application/json",
        "user-agent": "test-client",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
      "user-agent": "test-client",
    })
  })

  test("does not forward Anthropic-only headers to OpenAI-compatible providers", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        authType: "authorization",
        type: "openai-compatible",
      }),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })
  })
})

describe("inspectProviderBaseUrl", () => {
  test("accepts HTTPS and loopback HTTP providers", () => {
    expect(inspectProviderBaseUrl("https://api.example.com/v1/")).toEqual({
      baseUrl: "https://api.example.com/v1",
      insecureRemoteHttp: false,
    })
    expect(inspectProviderBaseUrl("http://127.0.0.1:8080/v1")).toEqual({
      baseUrl: "http://127.0.0.1:8080/v1",
      insecureRemoteHttp: false,
    })
  })

  test("classifies remote HTTP and rejects unsafe URL forms", () => {
    const insecureProvider = inspectProviderBaseUrl("http://api.example.com/v1")
    expect(insecureProvider).toEqual({
      baseUrl: "http://api.example.com/v1",
      insecureRemoteHttp: true,
    })
    expect(getInsecureProviderWarning("custom", insecureProvider)).toContain(
      "API key, prompts, and responses can be intercepted",
    )
    expect(
      getInsecureProviderWarning(
        "custom",
        inspectProviderBaseUrl("https://api.example.com/v1"),
      ),
    ).toBeNull()
    expect(inspectProviderBaseUrl("file:///tmp/provider")).toBeNull()
    expect(inspectProviderBaseUrl("https://key@example.com/v1")).toBeNull()
    expect(
      inspectProviderBaseUrl("https://example.com/v1?key=value"),
    ).toBeNull()
  })
})

describe("resolveProviderAuthType", () => {
  test("falls back to OpenAI-compatible default for invalid authType", () => {
    expect(
      resolveProviderAuthType("dash", "invalid-auth-type", "openai-compatible"),
    ).toBe("authorization")
  })

  test("falls back to Anthropic default for invalid authType", () => {
    expect(
      resolveProviderAuthType("custom", "invalid-auth-type", "anthropic"),
    ).toBe("x-api-key")
  })

  test("falls back for non-codex oauth2 providers", () => {
    expect(
      resolveProviderAuthType("custom", "oauth2", "openai-responses"),
    ).toBe("authorization")
  })
})
