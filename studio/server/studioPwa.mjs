import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const publicFiles = [
  'manifest.webmanifest',
  'icons/studio-192.png',
  'icons/studio-512.png',
  'night-signal.webp',
  'licenses/signalsmith-stretch.txt',
]

export function studioPwaPlugin() {
  let base = '/'
  return {
    name: 'magik-studio-pwa',
    apply: 'build',
    configResolved(config) { base = config.base },
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: `${base}manifest.webmanifest` }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}icons/studio-192.png` }, injectTo: 'head' },
      ]
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const worker = readFileSync(new URL('./studioServiceWorker.js', import.meta.url), 'utf8')
        const hash = createHash('sha256').update(worker)
        const files = []
        function include(name, content) {
          hash.update(name).update('\0').update(content)
          files.push(name)
        }
        if (!bundle['index.html']) this.error('The Studio offline build requires index.html.')
        for (const name of Object.keys(bundle).sort()) {
          const entry = bundle[name]
          if (name === 'index.html' || (name.startsWith('assets/') && /\.(m?js|css|wasm|woff2?|svg|png|webp)$/i.test(name))) {
            include(name, entry.type === 'chunk' ? entry.code : entry.source)
          }
        }
        for (const name of publicFiles) include(name, readFileSync(new URL(`../public/${name}`, import.meta.url)))
        this.emitFile({
          type: 'asset',
          fileName: 'studio-sw.js',
          source: `const BUILD = ${JSON.stringify(hash.digest('hex').slice(0, 20))};\nconst FILES = ${JSON.stringify(files)};\n${worker}`,
        })
      },
    },
  }
}
