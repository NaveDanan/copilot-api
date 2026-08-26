import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getStartupSecurityWarnings, resolveServerTls } from "~/start"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  )
})

describe("startup security controls", () => {
  test("warns for every explicitly enabled disclosure route", () => {
    const warnings = getStartupSecurityWarnings({
      githubToken: "github-token",
      proxyEnv: true,
      showToken: true,
      verbose: true,
    })

    expect(warnings).toHaveLength(4)
    expect(warnings.join("\n")).toContain("process arguments")
    expect(warnings.join("\n")).toContain("prints live")
    expect(warnings.join("\n")).toContain("complete prompts")
    expect(warnings.join("\n")).toContain("configured proxy")
  })

  test("does not warn when disclosure options are disabled", () => {
    expect(
      getStartupSecurityWarnings({
        proxyEnv: false,
        showToken: false,
        verbose: false,
      }),
    ).toEqual([])
  })

  test("loads a complete TLS certificate and key pair from files", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "copilot-api-tls-"),
    )
    temporaryDirectories.push(directory)
    const certPath = path.join(directory, "cert.pem")
    const keyPath = path.join(directory, "key.pem")
    await Promise.all([
      fs.writeFile(certPath, "certificate"),
      fs.writeFile(keyPath, "private-key"),
    ])

    expect(await resolveServerTls(certPath, keyPath)).toEqual({
      cert: "certificate",
      key: "private-key",
    })
    expect(await resolveServerTls(undefined, undefined)).toBeUndefined()
    expect(resolveServerTls(certPath, undefined)).rejects.toThrow(
      "must be configured together",
    )
  })

  test("does not accept private-key contents as a command argument", () => {
    expect(
      resolveServerTls("certificate", "-----BEGIN " + "PRIVATE KEY-----"),
    ).rejects.toThrow()
  })
})
