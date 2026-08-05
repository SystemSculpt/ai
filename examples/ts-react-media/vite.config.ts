import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev-only workaround for a nitro dev-middleware heuristic.
//
// `nitro/dist/_build/vite.dev.mjs` decides whether a request is a static asset
// (and so must NOT reach the server) from `Sec-Fetch-Dest`:
//
//   isAsset = fetchDest && fetchDest !== 'empty'
//     ? !/^(?:document|iframe|frame)$/.test(fetchDest)
//     : isAssetByExt
//
// Anything that isn't a document — `image`, `audio`, `video`, `script`, `font`
// — is treated as an asset and falls through to vite's static middleware,
// which has no file to serve and 404s. The extension branch is only consulted
// when the header is absent/`empty`, so renaming the route doesn't help.
//
// It only bites routes nitro sees under Start's catch-all `/**` (an explicitly
// registered nitro route short-circuits the check), which is every server route
// here. So `<video src="/api/artifacts?id=…">` 404s in dev while the same URL
// opened as a document download (or fetched from JS) returns the bytes —
// and production is unaffected, since this middleware only exists in the vite
// dev server.
//
// Presenting `empty` for our own API paths routes them back to the server
// without changing what the browser actually sends. Same plugin as
// `examples/ts-react-chat/vite.config.ts`.
const nitroServeApiToSubresources = {
  name: 'nitro-serve-api-to-subresources',
  enforce: 'pre',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/api/')) req.headers['sec-fetch-dest'] = 'empty'
      next()
    })
  },
} as const satisfies import('vite').PluginOption

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    nitroServeApiToSubresources,
    tailwindcss(),
    tanstackStart(),
    nitro(),
    viteReact(),
  ],
  nitro: {},
})
