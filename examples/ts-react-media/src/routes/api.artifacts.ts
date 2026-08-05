import { createFileRoute } from '@tanstack/react-router'
import {
  parseRangeHeader,
  retrieveArtifact,
  retrieveBlob,
} from '@tanstack/ai-persistence'
import { generationServerPersistence } from '@/lib/generation-persistence'

/**
 * Serves persisted generation media by artifact id.
 *
 * `withGenerationPersistence` stamps this URL onto every artifact ref via
 * `artifactUrl`, so both live and hydrated results play from our origin
 * instead of the provider's expiring link. Video seeking needs HTTP Range →
 * 206 responses (Safari refuses a source that ignores Range).
 */
export const Route = createFileRoute('/api/artifacts')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const artifactId = new URL(request.url).searchParams.get('id')
        if (!artifactId) {
          return new Response('missing artifact id', { status: 400 })
        }

        const persistence = generationServerPersistence()
        const artifact = await retrieveArtifact(persistence, artifactId)
        if (!artifact) return new Response('not found', { status: 404 })

        // Single-user demo: no session check. A multi-user app MUST authorize
        // here against `artifact.threadId` before serving.

        const range = parseRangeHeader(
          request.headers.get('range'),
          artifact.size,
        )
        if (range === 'unsatisfiable') {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'content-range': `bytes */${artifact.size}` },
          })
        }

        const blob = await retrieveBlob(
          persistence,
          artifact,
          range ? { range } : undefined,
        )
        if (!blob) return new Response('not found', { status: 404 })

        const cacheHeaders = {
          'content-type': artifact.mimeType,
          'cache-control': 'private, max-age=31536000, immutable',
          'accept-ranges': 'bytes',
        }
        const body = blob.body ?? (await blob.arrayBuffer())

        if (blob.range) {
          const { offset, length } = blob.range
          return new Response(body, {
            status: 206,
            headers: {
              ...cacheHeaders,
              'content-length': String(length),
              'content-range': `bytes ${offset}-${offset + length - 1}/${artifact.size}`,
            },
          })
        }

        return new Response(body, {
          headers: {
            ...cacheHeaders,
            'content-length': String(artifact.size),
          },
        })
      },
    },
  },
})
