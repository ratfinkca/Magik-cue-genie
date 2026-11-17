import { fileURLToPath } from 'node:url'
import { localAnalyzerPlugin } from './server/analyzer.mjs'
import { studioPwaPlugin } from './server/studioPwa.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export default {
  plugins: [localAnalyzerPlugin(projectRoot), studioPwaPlugin()],
  server: { host: '127.0.0.1', cors: false },
  preview: { host: '127.0.0.1', cors: false },
}
