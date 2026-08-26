export function buildServerStartArgs(
  port: number,
  increasedSecurity = false,
): string[] {
  const args = ['start', '--port', String(port)]
  if (increasedSecurity) args.push('--strict-security')
  return args
}
