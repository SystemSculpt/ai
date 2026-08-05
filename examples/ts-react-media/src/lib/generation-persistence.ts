/**
 * Server-only generation persistence for Seedance Studio and Seedance Chat.
 *
 * Seedance video URLs expire ~24h after the task finishes. Wiring
 * `withGenerationPersistence` copies the finished bytes into our blob store
 * and rewrites the result URL to the app-origin `/api/artifacts` route, so a
 * restored (or reloaded) clip still plays.
 *
 * Backed by on-disk sqlite (`./.data/generation.db`) via the same
 * `node:sqlite` adapter the `ts-react-chat` example uses. An in-memory store
 * is the wrong default here: Seedance jobs take minutes, the POST that records
 * a run and the GET that serves its bytes are separate requests, and Vite HMR
 * re-evaluates this module mid-session — which would 404 every artifact URL
 * already on screen. On disk, clips survive an edit, a restart, and a reload.
 * `.data/` is gitignored.
 *
 * **Do not import this module from client components.** The getter is lazy so
 * a mistaken client import does not open the database at module load, but the
 * store itself is Node-only (`node:sqlite`). Thread-id helpers live in
 * `generation-ids.ts`.
 */

import { withGenerationPersistence } from '@tanstack/ai-persistence'
import type { GenerationMiddleware } from '@tanstack/ai'
import type { AIPersistence } from '@tanstack/ai-persistence'
import { sqlitePersistence } from './sqlite-persistence'

export {
  SEEDANCE_STUDIO_THREAD_ID,
  seedanceChatThreadId,
} from './generation-ids'

let instance: AIPersistence | undefined

/**
 * Lazily opened generation stores (runs + artifacts + blobs).
 * Same process reuses one connection; reopen is free after HMR if the
 * previous module instance is gone — the db file is the source of truth.
 */
export function generationServerPersistence(): AIPersistence {
  return (instance ??= sqlitePersistence({
    url: './.data/generation.db',
    migrate: true,
  }))
}

/** Serve URL stamped onto every persisted artifact ref. */
export function artifactServeUrl(artifactId: string): string {
  return `/api/artifacts?id=${encodeURIComponent(artifactId)}`
}

/**
 * Middleware that records the run and copies finished media into the blob
 * store, rewriting result URLs to {@link artifactServeUrl}.
 */
export function seedanceGenerationMiddleware(
  threadId: string,
): GenerationMiddleware {
  return withGenerationPersistence(generationServerPersistence(), {
    threadId,
    artifactUrl: (ref) => artifactServeUrl(ref.artifactId),
  })
}
