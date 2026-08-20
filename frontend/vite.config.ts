import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Dev-time API origin. In production Caddy serves the SPA and the API on one origin. */
/**
 * Where `/api` goes in dev. Overridable because port 3000 is a popular default
 * and may already be taken by something else on the machine — a proxy silently
 * pointing at another app is a confusing way to spend an afternoon.
 */
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000';

/**
 * The version shown at the bottom of `/settings`.
 *
 * Read from `package.json` at config time rather than imported: the app
 * `tsconfig` has neither `resolveJsonModule` nor `package.json` in its
 * `include`, and a hard-coded copy of the number in `src/` is a string that
 * silently goes stale the first time somebody bumps the real one.
 */
const APP_VERSION: string =
  (
    JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version?: string;
    }
  ).version ?? '0.0.0';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // D7: injectManifest, because the push handler is ours — `generateSW`
      // would overwrite it on every build.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // The user decides when to reload; a silent `autoUpdate` swap mid-edit
      // loses form state in an installed PWA.
      registerType: 'prompt',
      // Registration is done by hand in `src/app/pwa/register-sw.ts` so we can
      // show a Russian "обновить приложение" prompt instead of the default.
      injectRegister: null,
      minify: true,
      injectManifest: {
        globDirectory: 'dist',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
        // Vite hashes assets, so a generous ceiling is safe and avoids silently
        // dropping a large vendor chunk out of the precache.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
      },
      devOptions: {
        // Lets us exercise install/update/push flows with `vite dev`.
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html',
        suppressWarnings: true,
      },
      includeAssets: ['favicon.svg', 'favicon.ico', 'icons/apple-touch-icon-180.png'],
      manifest: {
        id: '/',
        name: 'Семья — общий дом',
        short_name: 'Семья',
        description:
          'Общие дела, календарь, покупки и копилки одной семьи. Задачи по справедливости, напоминания на телефон.',
        lang: 'ru',
        dir: 'ltr',
        scope: '/',
        start_url: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui', 'browser'],
        orientation: 'portrait',
        theme_color: '#fdf8f2',
        background_color: '#fdf8f2',
        categories: ['productivity', 'lifestyle', 'utilities'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Сегодня',
            short_name: 'Сегодня',
            description: 'Дела и события на сегодня',
            url: '/?source=shortcut',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Задачи',
            short_name: 'Задачи',
            description: 'Список семейных задач',
            url: '/tasks?source=shortcut',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Покупки',
            short_name: 'Покупки',
            description: 'Общий список покупок',
            url: '/shopping?source=shortcut',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
        screenshots: [
          {
            src: '/screenshots/mobile-today.png',
            sizes: '1080x1920',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Сегодня — дела и события дня',
          },
          {
            src: '/screenshots/mobile-tasks.png',
            sizes: '1080x1920',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Задачи — кто и что делает',
          },
          {
            src: '/screenshots/desktop-today.png',
            sizes: '1280x800',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Рабочий стол — обзор недели',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: false,
        // Cookies are `__Host-` prefixed and `Path=/`; keeping the origin as
        // localhost:5173 is what makes them survive the proxy hop in dev.
        secure: false,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_PROXY_TARGET, changeOrigin: false, secure: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
