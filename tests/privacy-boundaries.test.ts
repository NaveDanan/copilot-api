import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { usageViewerContentSecurityPolicy } from "~/usage-viewer"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempConfig(config: object): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-boundaries-"))
  tempDirs.push(tempDir)
  fs.writeFileSync(
    path.join(tempDir, "config.json"),
    `${JSON.stringify(config)}\n`,
    "utf8",
  )
  return tempDir
}

function runScript(
  tempDir: string,
  script: string,
  environment: NodeJS.ProcessEnv = {},
): unknown {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      ...environment,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  const stdout = decoder.decode(result.stdout)
  const stderr = decoder.decode(result.stderr)
  if (result.exitCode !== 0) {
    throw new Error(
      `Privacy boundary script failed with exit code ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }

  const resultLine = stdout
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("RESULT:"))
  if (!resultLine) {
    throw new Error(`Privacy boundary script returned no result:\n${stdout}`)
  }

  return JSON.parse(resultLine.slice("RESULT:".length)) as unknown
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("privacy boundaries", () => {
  test("gates the Anthropic environment key behind strict security", () => {
    const compatibilityResult = runScript(
      createTempConfig({}),
      'const { getAnthropicApiKey } = await import("./src/lib/config"); console.log(`RESULT:${JSON.stringify(getAnthropicApiKey() ?? null)}`);',
      {
        ANTHROPIC_API_KEY: "environment-secret",
      },
    )
    expect(compatibilityResult).toBe("environment-secret")

    const unconfiguredStrictResult = runScript(
      createTempConfig({}),
      'const { state } = await import("./src/lib/state"); state.strictSecurity = true; const { getAnthropicApiKey } = await import("./src/lib/config"); console.log(`RESULT:${JSON.stringify(getAnthropicApiKey() ?? null)}`);',
      {
        ANTHROPIC_API_KEY: "environment-secret",
      },
    )
    expect(unconfiguredStrictResult).toBeNull()

    const configuredResult = runScript(
      createTempConfig({ anthropicApiKey: " configured-secret " }),
      'const { state } = await import("./src/lib/state"); state.strictSecurity = true; const { getAnthropicApiKey } = await import("./src/lib/config"); console.log(`RESULT:${JSON.stringify(getAnthropicApiKey() ?? null)}`);',
      {
        ANTHROPIC_API_KEY: "environment-secret",
      },
    )
    expect(configuredResult).toBe("configured-secret")
  })

  test("keeps token access admin-only and rejects browser exposure", () => {
    const result = runScript(
      createTempConfig({ auth: { apiKeys: [] } }),
      [
        'const { state: runtimeState } = await import("./src/lib/state");',
        "runtimeState.strictSecurity = true;",
        'const { mergeConfigWithDefaults } = await import("./src/lib/config");',
        "const config = mergeConfigWithDefaults();",
        'const { server } = await import("./src/server");',
        'const { state } = await import("./src/lib/state");',
        'state.copilotToken = "sensitive-token";',
        'const root = await server.request("http://localhost/", { headers: { origin: "https://attacker.example" } });',
        'const rebound = await server.request("http://attacker.example/");',
        'const legacyToken = await server.request("http://localhost/token");',
        'const deniedToken = await server.request("http://localhost/admin/token");',
        'const allowedToken = await server.request("http://localhost/admin/token", { headers: { "x-api-key": config.auth.adminApiKey } });',
        'const viewer = await server.request("http://localhost/usage-viewer");',
        'const viewerCss = await server.request("http://localhost/usage-viewer/usage-viewer.css");',
        "console.log(`RESULT:${JSON.stringify({",
        '  rootStatus: root.status, cors: root.headers.get("access-control-allow-origin"),',
        "  reboundStatus: rebound.status, legacyTokenStatus: legacyToken.status,",
        "  deniedTokenStatus: deniedToken.status, allowedTokenStatus: allowedToken.status,",
        "  allowedTokenBody: await allowedToken.json(),",
        '  allowedTokenCache: allowedToken.headers.get("cache-control"),',
        '  allowedTokenPragma: allowedToken.headers.get("pragma"),',
        '  viewerStatus: viewer.status, viewerCsp: viewer.headers.get("content-security-policy"),',
        '  viewerFrameOptions: viewer.headers.get("x-frame-options"),',
        '  viewerCssStatus: viewerCss.status, viewerCssType: viewerCss.headers.get("content-type"),',
        "})}`);",
      ].join("\n"),
    )

    expect(result).toEqual({
      rootStatus: 403,
      cors: null,
      reboundStatus: 421,
      legacyTokenStatus: 404,
      deniedTokenStatus: 401,
      allowedTokenStatus: 200,
      allowedTokenBody: {
        token: "sensitive-token",
      },
      allowedTokenCache: "no-store",
      allowedTokenPragma: "no-cache",
      viewerStatus: 200,
      viewerCsp: usageViewerContentSecurityPolicy,
      viewerFrameOptions: "DENY",
      viewerCssStatus: 200,
      viewerCssType: "text/css; charset=UTF-8",
    })
  })

  test("keeps legacy host and CORS behavior when strict security is off", () => {
    const result = runScript(
      createTempConfig({ auth: { apiKeys: [] } }),
      [
        'const { state } = await import("./src/lib/state");',
        "state.strictSecurity = false;",
        'const { server } = await import("./src/server");',
        'const crossOrigin = await server.request("http://localhost/", { headers: { origin: "https://client.example" } });',
        'const remoteHost = await server.request("http://gateway.example/");',
        'console.log(`RESULT:${JSON.stringify({ crossOriginStatus: crossOrigin.status, cors: crossOrigin.headers.get("access-control-allow-origin"), remoteHostStatus: remoteHost.status })}`);',
      ].join("\n"),
    )

    expect(result).toEqual({
      crossOriginStatus: 200,
      cors: "*",
      remoteHostStatus: 200,
    })
  })
})
