#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"
import { readFile } from "node:fs/promises"

import { runProviderSetup } from "./auth"
import { listEnabledProviders, mergeConfigWithDefaults } from "./lib/config"
import { readGitHubToken } from "./lib/credential-store"
import { getLatestModelForFamily } from "./lib/models"
import {
  assertSafeServerBinding,
  assertSafeServerTransport,
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  isLoopbackHostname,
} from "./lib/network-security"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import {
  getConfiguredApiKeys,
  getMissingApiKeysMessage,
} from "./lib/request-auth"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { logUser, setupCopilotToken } from "./lib/token"
import { cacheModels } from "./services/copilot/models-cache"
import {
  cacheMacMachineId,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./services/vscode-env"

interface RunServerOptions {
  host?: string
  port: number
  verbose: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  allowInsecureHttp: boolean
  strictSecurity: boolean
  tlsCert?: string
  tlsKey?: string
}

export interface StartupSecurityOptions {
  githubToken?: string
  proxyEnv: boolean
  showToken: boolean
  verbose: boolean
}

export function resolveServerHostname(
  host: string | undefined,
  strictSecurity: boolean,
): string {
  return host?.trim() || (strictSecurity ? DEFAULT_SERVER_HOST : "0.0.0.0")
}

export function getStartupSecurityWarnings(
  options: StartupSecurityOptions,
): Array<string> {
  return [
    ...(options.githubToken?.trim() ?
      [
        "SECURITY WARNING: --github-token exposes a long-lived credential through process arguments and shell history. Prefer `copilot-api auth login`.",
      ]
    : []),
    ...(options.showToken ?
      [
        "SECURITY WARNING: --show-token prints live GitHub, Copilot, and Codex tokens to terminal output and captured logs.",
      ]
    : []),
    ...(options.verbose ?
      [
        "PRIVACY WARNING: --verbose writes complete prompts, responses, tool payloads, and stream events to local log files for up to 7 days.",
      ]
    : []),
    ...(options.proxyEnv ?
      [
        "SECURITY WARNING: --proxy-env allows the configured proxy and trusted interception CAs to observe provider credentials and chat traffic.",
      ]
    : []),
  ]
}

export async function resolveServerTls(
  tlsCert: string | undefined,
  tlsKey: string | undefined,
): Promise<{ cert: string; key: string } | undefined> {
  const certPath = tlsCert?.trim()
  const keyPath = tlsKey?.trim()
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("--tls-cert and --tls-key must be configured together")
  }
  if (!certPath || !keyPath) {
    return undefined
  }

  const [cert, key] = await Promise.all([
    readFile(certPath, "utf8"),
    readFile(keyPath, "utf8"),
  ])
  if (!cert.trim() || !key.trim()) {
    throw new Error("TLS certificate and private key files must not be empty")
  }

  return { cert, key }
}

async function setupCopilotMode(
  githubToken: string,
  fromCli: boolean,
  serverUrl: string,
  claudeCode: boolean,
): Promise<void> {
  state.githubToken = githubToken
  consola.info(
    fromCli ?
      "Using provided GitHub token"
    : "Using GitHub token from local file",
  )
  consola.warn(
    "PRIVACY NOTICE: Copilot mode sends a persistent VS Code device ID and a hashed machine identifier to GitHub Copilot.",
  )

  await logUser()

  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  if (claudeCode) {
    runClaudeCode(serverUrl)
  }
}

function runClaudeCode(serverUrl: string): void {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )

  invariant(state.models, "Models should be loaded by now")

  // Default to the latest available model for each Claude Code size tier so
  // opus maps to opus, sonnet maps to sonnet, and haiku maps to haiku.
  const opusModel = getLatestModelForFamily("opus")?.id
  const sonnetModel = getLatestModelForFamily("sonnet")?.id
  const haikuModel = getLatestModelForFamily("haiku")?.id

  consola.info(
    "Selected default Claude Code models:\n"
      + `- Opus:   ${opusModel ?? "(none available)"}\n`
      + `- Sonnet: ${sonnetModel ?? "(none available)"}\n`
      + `- Haiku:  ${haikuModel ?? "(none available)"}`,
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: sonnetModel ?? opusModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_BEDROCK: "0",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      MCP_CONNECT_TIMEOUT_MS: "20000",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

async function setupProviderMode(
  serverUrl: string,
  claudeCode: boolean,
): Promise<void> {
  const enabledProviders = listEnabledProviders()

  if (enabledProviders.length > 0) {
    consola.info(`Using enabled providers: ${enabledProviders.join(", ")}`)
    return
  }

  consola.info("No enabled providers found. Setting one up...")
  await runProviderSetup()

  if (state.githubToken) {
    await setupCopilotMode(state.githubToken, false, serverUrl, claudeCode)
    return
  }

  const providersAfterSetup = listEnabledProviders()
  if (providersAfterSetup.length === 0) {
    throw new Error(
      "Failed to configure any provider. Run `copilot-api auth login` to set one up.",
    )
  }
  consola.info(`Configured providers: ${providersAfterSetup.join(", ")}`)
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  consola.options.throttle = 0

  state.strictSecurity = options.strictSecurity

  for (const warning of getStartupSecurityWarnings(options)) {
    consola.warn(warning)
  }

  mergeConfigWithDefaults()
  const hostname = resolveServerHostname(options.host, options.strictSecurity)
  if (options.strictSecurity) {
    assertSafeServerBinding(hostname, getConfiguredApiKeys())
  }
  const serverTls = await resolveServerTls(options.tlsCert, options.tlsKey)
  if (options.strictSecurity) {
    assertSafeServerTransport(
      hostname,
      Boolean(serverTls),
      options.allowInsecureHttp,
    )
  }
  if (!serverTls && !isLoopbackHostname(hostname)) {
    consola.warn(
      "SECURITY WARNING: --allow-insecure-http exposes API keys, prompts, and responses to network interception. Use --tls-cert and --tls-key for remote access.",
    )
  }

  const missingApiKeysMessage = getMissingApiKeysMessage()
  if (missingApiKeysMessage) {
    consola.info(missingApiKeysMessage)
  }

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()

  const serverUrl = formatServerUrl(hostname, options.port, Boolean(serverTls))

  const githubToken = options.githubToken?.trim() || (await readGitHubToken())
  if (githubToken) {
    await setupCopilotMode(
      githubToken,
      Boolean(options.githubToken?.trim()),
      serverUrl,
      options.claudeCode,
    )
  } else {
    await setupProviderMode(serverUrl, options.claudeCode)
  }

  consola.box(
    `🌐 Usage Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
  )

  const { server } = await import("./server")

  serve({
    fetch: server.fetch as ServerHandler,
    hostname,
    port: options.port,
    tls: serverTls,
    bun: {
      idleTimeout: 0,
    },
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    host: {
      type: "string",
      description:
        "Host to listen on (default: 0.0.0.0, or 127.0.0.1 with --strict-security)",
    },
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "allow-insecure-http": {
      type: "boolean",
      default: false,
      description:
        "Allow plaintext HTTP on non-loopback hosts (exposes credentials and chats to network interception)",
    },
    "strict-security": {
      type: "boolean",
      default: false,
      description:
        "Enable strict network, browser, provider, and request security checks",
    },
    "tls-cert": {
      type: "string",
      description: "Path to a TLS certificate PEM file",
    },
    "tls-key": {
      type: "string",
      description: "Path to a TLS private-key PEM file",
    },
  },
  run({ args }) {
    return runServer({
      host: args.host,
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      allowInsecureHttp: args["allow-insecure-http"],
      strictSecurity: args["strict-security"],
      tlsCert: args["tls-cert"],
      tlsKey: args["tls-key"],
    })
  },
})
