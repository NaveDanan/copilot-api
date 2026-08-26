import fs from 'node:fs/promises'

import {
  ipcMain,
  shell,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'

import { normalizeApiKeys } from '../../src/lib/request-auth'
import { PATHS } from '../../src/lib/paths'
import {
  getDeviceCode,
  pollAccessToken,
  getGitHubUser,
  saveToken,
  readToken,
  clearToken,
  getCopilotAccountType,
} from './auth'
import { tMain } from './i18n'
import {
  configureProviderWithAuthStatus,
  getDesktopAuthStatus,
  getEnabledDesktopProviders,
  loginCodexForDesktop,
  shouldStartInProviderMode,
} from './provider-auth'
import {
  startServer,
  stopServer,
  getPort,
  getLogs,
  isRunning,
} from './server-manager'
import {
  readSettings,
  mergeSettingsUpdate,
  setIncreasedSecurityPreference,
  updateSettings,
} from './settings-store'
import { isSafeExternalUrl, isTrustedRendererUrl } from './renderer-security'
import {
  readServerKeysConfig,
  writeServerKeysConfig,
} from './server-auth-config'
import type {
  DesktopAuthMode,
  DesktopProxySettings,
  DesktopSettings,
  DesktopSettingsUpdate,
  ModelMappingsConfig,
  ProviderAuthInput,
  ServerAuthInfo,
  ServerKeysConfigUpdate,
} from '../src/types/ipc'

interface ConfigApiErrorResponse {
  error?: {
    message?: string
  }
}

type ServerAuthScope = 'default' | 'admin'

interface IpcHandlersOptions {
  trustedRendererUrl: string
  getEffectiveProxySettings?: (
    settings: DesktopSettings,
  ) => DesktopProxySettings
  onSettingsChange?: (
    settings: DesktopSettings,
    prevSettings: DesktopSettings,
  ) => void | Promise<void>
  onBeforeSettingsSave?: (
    settings: DesktopSettings,
    prevSettings: DesktopSettings,
  ) => void | Promise<void>
  onQuit?: () => void | Promise<void>
}

function assertTrustedIpcSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  trustedRendererUrl: string,
): void {
  const senderFrame = event.senderFrame
  if (
    event.sender !== mainWindow.webContents
    || senderFrame !== mainWindow.webContents.mainFrame
    || !senderFrame
    || !isTrustedRendererUrl(senderFrame.url, trustedRendererUrl)
  ) {
    throw new Error('Blocked IPC request from an untrusted renderer')
  }
}

function normalizeApiKey(apiKey: unknown): string | null {
  if (typeof apiKey !== 'string') {
    return null
  }

  const normalizedApiKey = apiKey.trim()
  return normalizedApiKey || null
}

async function getServerAuthInfo(
  scope: ServerAuthScope = 'default',
): Promise<ServerAuthInfo> {
  try {
    const raw = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const parsed =
      raw.trim() ?
        (JSON.parse(raw) as {
          auth?: { apiKeys?: unknown; adminApiKey?: unknown }
        })
      : {}
    const apiKey =
      scope === 'admin' ?
        normalizeApiKey(parsed.auth?.adminApiKey)
      : (normalizeApiKeys(parsed.auth?.apiKeys)[0] ?? null)

    if (!apiKey) {
      return { enabled: false }
    }

    return {
      enabled: true,
      headerName: 'x-api-key',
      headerValue: apiKey,
    }
  } catch {
    return { enabled: false }
  }
}

async function getServerRequestHeaders(
  scope: ServerAuthScope = 'default',
): Promise<Record<string, string> | undefined> {
  const authInfo = await getServerAuthInfo(scope)
  if (!authInfo.enabled || !authInfo.headerName || !authInfo.headerValue) {
    return undefined
  }

  return {
    [authInfo.headerName]: authInfo.headerValue,
  }
}

function getConfigApiBaseUrl(): string {
  if (!isRunning()) {
    throw new Error(
      'Server is not running. Start the service before editing advanced config.',
    )
  }

  return `http://localhost:${getPort()}/admin/config/model-mappings`
}

async function readConfigApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ConfigApiErrorResponse
    return payload.error?.message ?? response.statusText
  } catch {
    return response.statusText
  }
}

async function fetchModelMappingsConfig(): Promise<ModelMappingsConfig> {
  const headers = await getServerRequestHeaders('admin')
  const response = await fetch(getConfigApiBaseUrl(), {
    headers,
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(await readConfigApiError(response))
  }

  return (await response.json()) as ModelMappingsConfig
}

async function saveModelMappingsViaApi(
  modelMappings: Record<string, string>,
): Promise<void> {
  const headers = await getServerRequestHeaders('admin')
  const response = await fetch(getConfigApiBaseUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ modelMappings }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(await readConfigApiError(response))
  }
}

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  options: IpcHandlersOptions,
): void {
  const handle = <TArguments extends Array<unknown>, TResult>(
    channel: string,
    listener: (
      event: IpcMainInvokeEvent,
      ...args: TArguments
    ) => TResult | Promise<TResult>,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event, mainWindow, options.trustedRendererUrl)
      return listener(event, ...(args as TArguments))
    })
  }
  const on = <TArguments extends Array<unknown>>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: TArguments) => void,
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      assertTrustedIpcSender(event, mainWindow, options.trustedRendererUrl)
      listener(event, ...(args as TArguments))
    })
  }

  handle('auth:get-status', async () => getDesktopAuthStatus())

  // Auth: Start the OAuth device flow
  handle('auth:get-device-code', async () => {
    const deviceCode = await getDeviceCode()
    // Poll in the background and notify the renderer when the token arrives
    pollAccessToken(deviceCode)
      .then(async (token) => {
        await saveToken(token)
        const [, accountType] = await Promise.all([
          getGitHubUser(token),
          getCopilotAccountType(token),
        ])
        // Detect and persist the account type automatically after sign-in
        await updateSettings((settings) => ({ ...settings, accountType }))
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:success', {
            success: true,
            mode: 'copilot',
          })
        }
      })
      .catch((err: Error) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:success', {
            success: false,
            error: err.message,
          })
        }
      })
    return deviceCode
  })

  // Auth: Save token directly
  handle('auth:save-token', async (_event, token: string) => {
    try {
      const [, accountType] = await Promise.all([
        getGitHubUser(token),
        getCopilotAccountType(token),
      ])
      await saveToken(token)
      // Detect and persist the account type automatically
      await updateSettings((settings) => ({ ...settings, accountType }))
      return { success: true, mode: 'copilot' }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Auth: Check the saved token
  handle('auth:check-saved', async () => getDesktopAuthStatus())

  handle(
    'auth:configure-provider',
    async (_event, input: ProviderAuthInput) => {
      try {
        return await configureProviderWithAuthStatus(input)
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  handle(
    'auth:start-codex-login',
    async (_event, callbackUrlOrCode?: string) => {
      try {
        return await loginCodexForDesktop({
          callbackUrlOrCode,
          openUrl: (url) => {
            if (!isSafeExternalUrl(url)) {
              throw new Error('Refusing to open an unsafe authentication URL')
            }
            return shell.openExternal(url)
          },
        })
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  // Auth: Log out
  handle('auth:logout', async () => {
    await clearToken()
  })

  // Server: Start
  handle(
    'server:start',
    async (_event, port: number, authMode?: DesktopAuthMode) => {
      const token = await readToken()
      const providerMode = shouldStartInProviderMode(authMode)
      const enabledProviders = getEnabledDesktopProviders()
      const tokenForStart = providerMode ? null : token

      if (!tokenForStart && enabledProviders.length === 0) {
        return {
          running: false,
          error: await tMain('server.authRequired'),
        }
      }

      const settings = await readSettings()
      const serverOptions = {
        increasedSecurity: settings.increasedSecurity,
        verbose: settings.verbose,
        showToken: settings.showToken,
        proxy: options.getEffectiveProxySettings?.(settings) ?? settings.proxy,
      }

      // Persist the last used port
      await updateSettings((currentSettings) => ({
        ...currentSettings,
        lastPort: port,
      }))

      return startServer(port, serverOptions)
    },
  )

  // Server: Stop
  handle('server:stop', async () => {
    await stopServer()
  })

  handle('server:get-status', () => ({
    running: isRunning(),
    port: getPort(),
  }))

  // Settings
  handle('settings:get', async () => readSettings())
  handle(
    'settings:set-increased-security',
    async (_event, enabled: boolean) => {
      if (typeof enabled !== 'boolean') {
        throw new Error('Increased security must be a boolean')
      }
      return setIncreasedSecurityPreference(enabled)
    },
  )
  handle(
    'settings:save',
    async (_event, settingsUpdate: DesktopSettingsUpdate) =>
      updateSettings(
        (settings) => mergeSettingsUpdate(settings, settingsUpdate),
        {
          beforePersist: (settings, previousSettings) =>
            options.onBeforeSettingsSave?.(settings, previousSettings),
          rollback: (previousSettings, settings) =>
            options.onBeforeSettingsSave?.(previousSettings, settings),
          afterPersist: (settings, previousSettings) =>
            options.onSettingsChange?.(settings, previousSettings),
        },
      ),
  )
  handle('config:get-model-mappings', async () => fetchModelMappingsConfig())
  handle(
    'config:save-model-mappings',
    async (_event, modelMappings: Record<string, string>) => {
      await saveModelMappingsViaApi(modelMappings)
    },
  )

  handle('auth:get-server-keys', () => readServerKeysConfig())
  handle('auth:save-server-keys', (_event, keys: ServerKeysConfigUpdate) =>
    writeServerKeysConfig(keys),
  )

  // Shell: Open the system browser
  handle('shell:open-url', async (_event, url: string) => {
    if (!isSafeExternalUrl(url)) {
      throw new Error('Refusing to open an unsafe external URL')
    }
    await shell.openExternal(url)
  })

  // Server: Proxy HTTP requests through the main process to bypass file:// origin CORS in the renderer
  handle('server:fetch-usage', async () => {
    const port = getPort()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`http://localhost:${port}/usage`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  handle('server:fetch-models', async () => {
    const port = getPort()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`http://localhost:${port}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  handle('server:fetch-token-usage', async (_event, period: string) => {
    const port = getPort()
    const normalizedPeriod =
      period === 'week' || period === 'month' ? period : 'day'
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(
        `http://localhost:${port}/token-usage?period=${normalizedPeriod}`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  handle('server:fetch-token-usage-daily', async (_event, period: string) => {
    const port = getPort()
    const normalizedPeriod =
      period === 'week' || period === 'month' ? period : 'day'
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(
        `http://localhost:${port}/token-usage/daily?period=${normalizedPeriod}`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  handle(
    'server:fetch-token-usage-events',
    async (_event, period: string, page: number, pageSize: number) => {
      const port = getPort()
      const normalizedPeriod =
        period === 'week' || period === 'month' ? period : 'day'
      const normalizedPage =
        Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
      const normalizedPageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20
      const params = new URLSearchParams({
        page: String(normalizedPage),
        page_size: String(normalizedPageSize),
        period: normalizedPeriod,
      })
      try {
        const headers = await getServerRequestHeaders()
        const res = await fetch(
          `http://localhost:${port}/token-usage/events?${params.toString()}`,
          {
            headers,
            signal: AbortSignal.timeout(5000),
          },
        )
        if (!res.ok) return null
        return (await res.json()) as unknown
      } catch {
        return null
      }
    },
  )

  handle('server:get-auth-info', async () => getServerAuthInfo())

  // Server: Return the in-memory log buffer
  handle('server:get-logs', () => getLogs())

  // Window controls (used by the custom title bar menu)
  on('window:reload', () => mainWindow.reload())
  on('window:minimize', () => mainWindow.minimize())
  on('window:maximize-toggle', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })
  on('window:close', () => mainWindow.close())
  on('window:quit', () => {
    void options.onQuit?.()
  })
  on('window:zoom-in', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level + 0.5)
  })
  on('window:zoom-out', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level - 0.5)
  })
  on('window:zoom-reset', () => mainWindow.webContents.setZoomLevel(0))

  handle('window:is-maximized', () => mainWindow.isMaximized())
}
