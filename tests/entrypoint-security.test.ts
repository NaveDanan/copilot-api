import { describe, expect, test } from "bun:test"
import fs from "node:fs"

const entrypointPath = new URL("../entrypoint.sh", import.meta.url)
const entrypoint = fs.readFileSync(entrypointPath, "utf8")

describe("Docker entrypoint security mode", () => {
  test("recognizes both strict-security boolean forms", () => {
    expect(entrypoint).toContain("--strict-security|--strict-security=true)")
    expect(entrypoint).toContain('if [ "$strict_security" = true ]')
    expect(entrypoint).toContain('if [ "$strict_security" = false ]')
  })

  test("uses POSIX-compatible LF line endings", () => {
    expect(entrypoint).not.toContain("\r\n")
  })
})
