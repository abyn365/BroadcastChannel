const TARGET_WHITELIST = [
  't.me',
  'telegram.org',
  'telegram.me',
  'telegram.dog',
  'cdn-telegram.org',
  'telesco.pe',
  'yandex.ru',
]
const MALFORMED_PROTOCOL_REGEX = /^https?:\/(?!\/)/i

export function resolveStaticProxyTarget(rawTarget: string): URL {
  const normalizedTarget = rawTarget
    .replace(MALFORMED_PROTOCOL_REGEX, protocol => `${protocol}/`)
  const resolvedTarget = normalizedTarget.startsWith('//') ? `https:${normalizedTarget}` : normalizedTarget
  return new URL(resolvedTarget)
}

export function isStaticProxyWhitelisted(target: URL): boolean {
  return TARGET_WHITELIST.some(domain => target.hostname.endsWith(domain))
}

export async function createStaticProxyResponse(request: Request, rawTarget: string): Promise<Response> {
  const target = resolveStaticProxyTarget(rawTarget)

  if (!isStaticProxyWhitelisted(target)) {
    return new Response('Proxy target not allowed', { status: 403 })
  }

  const response = await fetch(target.toString(), request)
  return new Response(response.body, response)
}
