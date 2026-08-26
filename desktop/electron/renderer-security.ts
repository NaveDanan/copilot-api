export function isTrustedRendererUrl(
  candidate: string,
  trustedRendererUrl: string,
): boolean {
  try {
    const candidateUrl = new URL(candidate)
    const trustedUrl = new URL(trustedRendererUrl)

    if (trustedUrl.protocol === 'file:') {
      candidateUrl.hash = ''
      trustedUrl.hash = ''
      return candidateUrl.href === trustedUrl.href
    }

    return (
      (trustedUrl.protocol === 'http:' || trustedUrl.protocol === 'https:')
      && candidateUrl.origin === trustedUrl.origin
    )
  } catch {
    return false
  }
}

export function isSafeExternalUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}
