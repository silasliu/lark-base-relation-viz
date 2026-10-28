import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const tlsDir = fileURLToPath(new URL('../../.snapnext-local/tls/', import.meta.url))
const certPath = resolve(tlsDir, 'm1air.crt')
const keyPath = resolve(tlsDir, 'm1air.key')
const hasTrustedTls = existsSync(certPath) && existsSync(keyPath)
const tailscaleHost = 'm1air.tail928fd4.ts.net'

export default defineConfig({
  // 相对路径：GitHub Pages 会部署在 /<repo>/ 子路径下，绝对路径 /assets/... 会 404。
  // 本项目没有前端路由，用 './' 在本地 dev 和 Pages 子路径下都能正确解析。
  base: './',
  // Use a real Tailscale-issued HTTPS cert when available. basicSsl is only a local fallback;
  // Feishu/M5 won't trust that self-signed cert, so use the .ts.net URL for cross-device testing.
  plugins: [react(), ...(!hasTrustedTls ? [basicSsl()] : [])],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    // public/ 里只有 mock-data.json —— 那是从真实 Base 导出的数据快照，
    // 只用于本地调试，绝不能进入构建产物（仓库是公开的，会被发布出去）。
    copyPublicDir: false,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    https: hasTrustedTls ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : undefined,
    hmr: hasTrustedTls
      ? { protocol: 'wss', host: tailscaleHost, clientPort: 5173 }
      : { protocol: 'wss' },
  },
})
