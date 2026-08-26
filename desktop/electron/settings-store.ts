import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { writeFileAtomically } from '../../src/lib/atomic-file'
import type {
  DesktopProxySettings,
  DesktopSettings,
  DesktopSettingsUpdate,
} from '../src/types/ipc'

const SETTINGS_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'copilot-api',
  'desktop-config.json',
)

const DEFAULT_SETTINGS: DesktopSettings = {
  apiHome: '',
  oauthApp: 'default',
  enterpriseUrl: '',
  lastPort: 4141,
  increasedSecurity: false,
  securitySuggestionShown: false,
  launchAtLogin: false,
  autoStartServer: false,
  minimizeToTray: false,
  accountType: 'individual',
  verbose: false,
  showToken: false,
  language: 'auto',
  theme: 'auto',
  proxy: {
    mode: 'system',
    http_proxy: 'http://127.0.0.1:8888',
    https_proxy: 'http://127.0.0.1:8888',
    no_proxy: 'localhost,127.0.0.1',
  },
}

let launchAtLoginFallback = DEFAULT_SETTINGS.launchAtLogin
let settingsWriteQueue = Promise.resolve()

export function setLaunchAtLoginFallback(enabled: boolean): void {
  launchAtLoginFallback = enabled
}

function isDesktopProxyMode(
  value: unknown,
): value is DesktopProxySettings['mode'] {
  return value === 'system' || value === 'custom' || value === 'direct'
}

export function normalizeProxySettings(
  proxy: Partial<DesktopProxySettings> | null | undefined,
): DesktopProxySettings {
  return {
    mode:
      isDesktopProxyMode(proxy?.mode) ?
        proxy.mode
      : DEFAULT_SETTINGS.proxy.mode,
    http_proxy:
      typeof proxy?.http_proxy === 'string' ?
        proxy.http_proxy
      : DEFAULT_SETTINGS.proxy.http_proxy,
    https_proxy:
      typeof proxy?.https_proxy === 'string' ?
        proxy.https_proxy
      : DEFAULT_SETTINGS.proxy.https_proxy,
    no_proxy:
      typeof proxy?.no_proxy === 'string' ?
        proxy.no_proxy
      : DEFAULT_SETTINGS.proxy.no_proxy,
  }
}

export function normalizeSettings(
  settings: Partial<DesktopSettings> | null | undefined,
): DesktopSettings {
  return {
    apiHome:
      typeof settings?.apiHome === 'string' ?
        settings.apiHome
      : DEFAULT_SETTINGS.apiHome,
    oauthApp:
      settings?.oauthApp === 'opencode' ?
        'opencode'
      : DEFAULT_SETTINGS.oauthApp,
    enterpriseUrl:
      typeof settings?.enterpriseUrl === 'string' ?
        settings.enterpriseUrl
      : DEFAULT_SETTINGS.enterpriseUrl,
    lastPort:
      typeof settings?.lastPort === 'number' ?
        settings.lastPort
      : DEFAULT_SETTINGS.lastPort,
    increasedSecurity:
      typeof settings?.increasedSecurity === 'boolean' ?
        settings.increasedSecurity
      : DEFAULT_SETTINGS.increasedSecurity,
    securitySuggestionShown:
      typeof settings?.securitySuggestionShown === 'boolean' ?
        settings.securitySuggestionShown
      : DEFAULT_SETTINGS.securitySuggestionShown,
    launchAtLogin:
      typeof settings?.launchAtLogin === 'boolean' ?
        settings.launchAtLogin
      : launchAtLoginFallback,
    autoStartServer:
      typeof settings?.autoStartServer === 'boolean' ?
        settings.autoStartServer
      : DEFAULT_SETTINGS.autoStartServer,
    minimizeToTray:
      typeof settings?.minimizeToTray === 'boolean' ?
        settings.minimizeToTray
      : DEFAULT_SETTINGS.minimizeToTray,
    accountType:
      (
        settings?.accountType === 'business'
        || settings?.accountType === 'enterprise'
      ) ?
        settings.accountType
      : DEFAULT_SETTINGS.accountType,
    verbose:
      typeof settings?.verbose === 'boolean' ?
        settings.verbose
      : DEFAULT_SETTINGS.verbose,
    showToken:
      typeof settings?.showToken === 'boolean' ?
        settings.showToken
      : DEFAULT_SETTINGS.showToken,
    language:
      (
        settings?.language === 'en'
        || settings?.language === 'zh'
        || settings?.language === 'auto'
      ) ?
        settings.language
      : DEFAULT_SETTINGS.language,
    theme:
      (
        settings?.theme === 'light'
        || settings?.theme === 'dark'
        || settings?.theme === 'auto'
      ) ?
        settings.theme
      : DEFAULT_SETTINGS.theme,
    proxy: normalizeProxySettings(settings?.proxy),
  }
}

export function readSettingsSync(): DesktopSettings {
  try {
    const raw = fsSync.readFileSync(SETTINGS_PATH, 'utf8')
    return normalizeSettings(JSON.parse(raw) as Partial<DesktopSettings>)
  } catch {
    return normalizeSettings(null)
  }
}

export async function readSettings(): Promise<DesktopSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8')
    return normalizeSettings(JSON.parse(raw) as Partial<DesktopSettings>)
  } catch {
    return normalizeSettings(null)
  }
}

export async function writeSettings(settings: DesktopSettings): Promise<void> {
  const normalizedSettings = normalizeSettings(settings)
  await enqueueSettingsWrite(() => {
    writeSettingsFile(normalizedSettings)
  })
}

export async function updateSettings(
  update: (settings: DesktopSettings) => DesktopSettings,
  hooks: {
    afterPersist?: (
      settings: DesktopSettings,
      previousSettings: DesktopSettings,
    ) => void | Promise<void>
    beforePersist?: (
      settings: DesktopSettings,
      previousSettings: DesktopSettings,
    ) => void | Promise<void>
    rollback?: (
      previousSettings: DesktopSettings,
      settings: DesktopSettings,
    ) => void | Promise<void>
  } = {},
): Promise<DesktopSettings> {
  return enqueueSettingsWrite(async () => {
    const settings = await readSettings()
    const nextSettings = normalizeSettings(update(settings))
    try {
      await hooks.beforePersist?.(nextSettings, settings)
      writeSettingsFile(nextSettings)
    } catch (error) {
      try {
        await hooks.rollback?.(settings, nextSettings)
      } catch (rollbackError) {
        console.error('Failed to roll back desktop settings:', rollbackError)
      }
      throw error
    }
    await hooks.afterPersist?.(nextSettings, settings)
    return nextSettings
  })
}

export function mergeSettingsUpdate(
  settings: DesktopSettings,
  update: DesktopSettingsUpdate,
): DesktopSettings {
  return {
    ...settings,
    apiHome: update.apiHome ?? settings.apiHome,
    oauthApp: update.oauthApp ?? settings.oauthApp,
    enterpriseUrl: update.enterpriseUrl ?? settings.enterpriseUrl,
    increasedSecurity: update.increasedSecurity ?? settings.increasedSecurity,
    launchAtLogin: update.launchAtLogin ?? settings.launchAtLogin,
    autoStartServer: update.autoStartServer ?? settings.autoStartServer,
    minimizeToTray: update.minimizeToTray ?? settings.minimizeToTray,
    verbose: update.verbose ?? settings.verbose,
    showToken: update.showToken ?? settings.showToken,
    language: update.language ?? settings.language,
    theme: update.theme ?? settings.theme,
    proxy: update.proxy ?? settings.proxy,
  }
}

function writeSettingsFile(settings: DesktopSettings): void {
  writeFileAtomically(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`)
}

function enqueueSettingsWrite<T>(task: () => T | Promise<T>): Promise<T> {
  const result = settingsWriteQueue.then(task, task)
  settingsWriteQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export async function setIncreasedSecurityPreference(
  enabled: boolean,
): Promise<DesktopSettings> {
  return updateSettings((settings) => ({
    ...settings,
    increasedSecurity: enabled,
    securitySuggestionShown: true,
  }))
}
