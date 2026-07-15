/**
 * Accept the production API origin, or an explicitly loopback-only HTTP
 * origin for testing an undeployed backend from the localhost lab.
 */
export function safeConvincedApiBase(value: string): string {
  const url = new URL(value)
  if (url.username || url.password) throw new Error('CONVINCED_API_BASE must not include credentials')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CONVINCED_API_BASE must be an origin without a path, query, or fragment')
  }
  if (url.protocol === 'https:') return url.origin
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (url.protocol === 'http:' && loopbackHosts.has(url.hostname)) return url.origin
  throw new Error('CONVINCED_API_BASE must use HTTPS; HTTP is allowed only for an explicit loopback host')
}

export function safeHttpsBase(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Dashboard bases must be HTTPS origins without credentials, paths, queries, or fragments')
  }
  return url.origin
}
