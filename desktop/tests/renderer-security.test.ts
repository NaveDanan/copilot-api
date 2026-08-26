import { describe, expect, test } from 'bun:test'

import {
  isSafeExternalUrl,
  isTrustedRendererUrl,
} from '../electron/renderer-security'

describe('Electron renderer security', () => {
  test('allows only the bundled file renderer in packaged mode', () => {
    const trusted = 'file:///C:/app/renderer/index.html'

    expect(isTrustedRendererUrl(trusted, trusted)).toBeTrue()
    expect(isTrustedRendererUrl(`${trusted}#dashboard`, trusted)).toBeTrue()
    expect(
      isTrustedRendererUrl('file:///C:/app/renderer/other.html', trusted),
    ).toBeFalse()
    expect(
      isTrustedRendererUrl('https://attacker.example', trusted),
    ).toBeFalse()
  })

  test('allows only the development renderer origin in development mode', () => {
    const trusted = 'http://127.0.0.1:5173/'

    expect(
      isTrustedRendererUrl('http://127.0.0.1:5173/settings', trusted),
    ).toBeTrue()
    expect(isTrustedRendererUrl('http://localhost:5173/', trusted)).toBeFalse()
    expect(isTrustedRendererUrl('https://127.0.0.1:5173/', trusted)).toBeFalse()
  })

  test('opens only credential-free HTTPS URLs externally', () => {
    expect(isSafeExternalUrl('https://github.com/example')).toBeTrue()
    expect(isSafeExternalUrl('http://github.com/example')).toBeFalse()
    expect(isSafeExternalUrl('https://token@github.com/example')).toBeFalse()
    expect(isSafeExternalUrl('file:///C:/secret.txt')).toBeFalse()
  })
})
