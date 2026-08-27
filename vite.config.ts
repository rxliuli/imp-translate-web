import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { playwright } from '@vitest/browser-playwright'
import { cpSync, mkdirSync } from 'node:fs'

export default defineConfig({
  base: '/translate/',
  plugins: [
    tanstackRouter(),
    react(),
    tailwindcss(),
    // Cloudflare static assets SPA fallback (`single-page-application`)
    // rewrites unmatched requests to the assets-root `/index.html`. Our app
    // is nested at `dist/translate/` to match the `imp.rxliuli.com/translate/*`
    // route (Cloudflare requires the build output to mirror the route path).
    // Copy the built index.html to the assets root so deep-link SPA fallback
    // (e.g. /translate/markdown) serves the app instead of returning 404.
    {
      name: 'copy-spa-index-to-assets-root',
      closeBundle() {
        mkdirSync('dist', { recursive: true })
        cpSync('dist/translate/index.html', 'dist/index.html')
      },
    },
  ],
  build: {
    outDir: './dist/translate',
  },
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
})
