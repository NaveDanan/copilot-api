import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

test('uses the OS fallback when the settings file does not exist', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-api-settings-'))
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dir, '../electron/settings-store.ts'),
  ).href
  const script = `
    import { readSettings, readSettingsSync, setLaunchAtLoginFallback } from ${JSON.stringify(moduleUrl)}
    setLaunchAtLoginFallback(true)
    const syncSettings = readSettingsSync()
    const asyncSettings = await readSettings()
    process.stdout.write(JSON.stringify([
      syncSettings.launchAtLogin,
      asyncSettings.launchAtLogin,
      syncSettings.increasedSecurity,
      asyncSettings.securitySuggestionShown,
    ]))
  `

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toBe('[true,true,false,false]')
  } finally {
    await fs.rm(home, { force: true, recursive: true })
  }
})

test('updates only the increased security preference', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-api-settings-'))
  const moduleUrl = pathToFileURL(
    path.join(import.meta.dir, '../electron/settings-store.ts'),
  ).href
  const script = `
    import { mergeSettingsUpdate, readSettings, setIncreasedSecurityPreference, updateSettings, writeSettings } from ${JSON.stringify(moduleUrl)}
    const settings = await readSettings()
    await writeSettings({ ...settings, lastPort: 5151, accountType: 'business' })
    const [saved] = await Promise.all([
      setIncreasedSecurityPreference(true),
      updateSettings((current) => ({ ...current, lastPort: 6262 })),
      updateSettings((current) => mergeSettingsUpdate(current, { theme: 'dark' })),
    ])
    const finalSettings = await readSettings()
    process.stdout.write(JSON.stringify({
      increasedSecurity: saved.increasedSecurity,
      securitySuggestionShown: saved.securitySuggestionShown,
      lastPort: finalSettings.lastPort,
      accountType: finalSettings.accountType,
      theme: finalSettings.theme,
    }))
  `

  try {
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      increasedSecurity: true,
      securitySuggestionShown: true,
      lastPort: 6262,
      accountType: 'business',
      theme: 'dark',
    })
  } finally {
    await fs.rm(home, { force: true, recursive: true })
  }
})
