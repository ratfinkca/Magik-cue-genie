const scope = new URL(self.registration.scope)
const shell = new URL('index.html', scope)
const apiPath = new URL('api', scope).pathname
const allowed = new Set(FILES.map(path => new URL(path, scope).href))
const prefix = `magik-cue-studio:${scope.pathname}:`
const cacheName = prefix + BUILD

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(
    Array.from(allowed, path => new Request(path, { cache: 'reload', credentials: 'same-origin' })),
  )))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name.startsWith(prefix) && name !== cacheName).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== shell.origin || request.headers.has('Range')
    || url.pathname === apiPath || url.pathname.startsWith(apiPath + '/')) return
  const launch = request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === shell.pathname)
  const target = launch ? shell.href : url.href
  // Only build-owned paths may be served from Cache Storage. Other requests
  // keep their normal lifecycle, including localhost analyzer traffic.
  if (!allowed.has(target)) return
  event.respondWith((async () => {
    const cache = await caches.open(cacheName)
    return await cache.match(target) ?? fetch(request)
  })())
})
