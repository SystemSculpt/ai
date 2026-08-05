/**
 * Blocking Seedance job helper for chat tools.
 *
 * Chat tools need a finished video URL (and ideally a last-frame URL for the
 * next extend step). The studio streams job status over SSE; tools instead
 * create + poll on the server until the task settles, then optionally re-read
 * the Ark task record for `content.last_frame_url` when `return_last_frame`
 * was requested.
 *
 * Persistence: each job is filed under `threadId` with
 * `withGenerationPersistence`, so the completed `url` is rewritten to the
 * durable `/api/artifacts` serve path before it is returned to the agent.
 */

import { generateVideo, getVideoJobStatus } from '@tanstack/ai'
import {
  BYTEPLUS_ARK_BASE_URL,
  bytePlusArkHeaders,
  byteplusVideo,
  getBytePlusArkApiKeyFromEnv,
  withBytePlusArkDefaults,
} from '@tanstack/ai-byteplus'
import type { MediaPrompt } from '@tanstack/ai/client'
import type {
  BytePlusVideoModelOrString,
  BytePlusVideoProviderOptions,
  BytePlusVideoTask,
} from '@tanstack/ai-byteplus'
import { seedanceChatThreadId } from './generation-ids'
import { seedanceGenerationMiddleware } from './generation-persistence'

const SEEDANCE_MAX_DURATION_MS = 30 * 60_000
const SEEDANCE_POLL_INTERVAL_MS = 5_000

export interface SeedanceRunInput {
  prompt: MediaPrompt
  model?: BytePlusVideoModelOrString
  /** Whole seconds; 2.0 / 1.5-pro also accept `-1` (model chooses). */
  duration?: number
  size?: string
  modelOptions?: BytePlusVideoProviderOptions
  /**
   * Generation scope for persistence. Required so finished bytes are filed
   * under a restoreable slot (typically `seedance-chat:<clipId>`).
   */
  threadId: string
  /** Optional progress sink (tool `emitCustomEvent`, logs, etc.). */
  onStatus?: (status: string, detail?: string) => void
}

export interface SeedanceRunResult {
  jobId: string
  model: string
  /** Durable app-origin URL when persistence rewrote it; else provider URL. */
  url: string
  /** Present when the job was created with `return_last_frame: true`. */
  lastFrameUrl?: string
  expiresAt?: string
  threadId: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Re-reads the finished Ark task so we can surface `last_frame_url`.
 * `getVideoJobStatus` only returns the video URL — last-frame chaining needs
 * the extra field from the raw task body.
 */
async function fetchLastFrameUrl(jobId: string): Promise<string | undefined> {
  const config = withBytePlusArkDefaults({
    apiKey: getBytePlusArkApiKeyFromEnv(),
    baseURL: BYTEPLUS_ARK_BASE_URL,
  })
  const response = await fetch(
    `${config.baseURL}/contents/generations/tasks/${encodeURIComponent(jobId)}`,
    { headers: bytePlusArkHeaders(config.apiKey) },
  )
  if (!response.ok) return undefined
  const body = (await response.json()) as BytePlusVideoTask
  const lastFrameUrl = body.content?.last_frame_url
  return typeof lastFrameUrl === 'string' && lastFrameUrl.length > 0
    ? lastFrameUrl
    : undefined
}

/**
 * Create a Seedance task and wait until it completes (or fails / times out).
 * Always requests `return_last_frame` so the chat agent can chain extends.
 * Persistence middleware records the run and rewrites the video URL to a
 * durable artifact serve path on the completing poll.
 */
export async function runSeedanceJob(
  input: SeedanceRunInput,
): Promise<SeedanceRunResult> {
  const model = input.model ?? 'dreamina-seedance-2-0-260128'
  const adapter = byteplusVideo(model)
  const wantLastFrame = input.modelOptions?.return_last_frame !== false
  const threadId = input.threadId
  const middleware = [seedanceGenerationMiddleware(threadId)]

  input.onStatus?.('creating', `Submitting Seedance job on ${model}`)

  // Durable `/api/artifacts` URLs are not fetchable by Ark. Images expand to
  // base64; video/audio rehydrate to the original Seedance sourceUrl.
  const { materializeSeedancePromptForArk } = await import('./materialize-media')
  const prompt = await materializeSeedancePromptForArk(input.prompt)

  const { jobId } = await generateVideo({
    adapter,
    prompt,
    ...(input.size !== undefined && { size: input.size }),
    ...(input.duration !== undefined &&
      input.duration > 0 && { duration: input.duration }),
    modelOptions: {
      return_last_frame: true,
      ...input.modelOptions,
      // Force last-frame capture for the iteration loop unless the caller
      // explicitly disabled it after the spread above — re-apply when wanted.
      ...(wantLastFrame ? { return_last_frame: true } : {}),
      ...(input.duration === -1 ? { duration: -1 } : {}),
    },
    threadId,
    middleware,
  })

  input.onStatus?.('queued', `Job ${jobId} created — polling Ark…`)

  const started = Date.now()
  while (Date.now() - started < SEEDANCE_MAX_DURATION_MS) {
    await sleep(SEEDANCE_POLL_INTERVAL_MS)

    // Same middleware + threadId so the poll that observes completion finishes
    // the generation run, copies bytes, and rewrites `url` to /api/artifacts.
    const status = await getVideoJobStatus({
      adapter,
      jobId,
      threadId,
      middleware,
    })
    input.onStatus?.(
      status.status,
      status.progress !== undefined
        ? `${status.status} (${status.progress}%)`
        : status.status,
    )

    if (status.status === 'failed') {
      throw new Error(status.error ?? `Seedance job ${jobId} failed`)
    }

    if (status.status === 'completed') {
      if (!status.url) {
        throw new Error(`Seedance job ${jobId} completed without a video URL`)
      }

      const lastFrameUrl = wantLastFrame
        ? await fetchLastFrameUrl(jobId)
        : undefined

      return {
        jobId,
        model,
        url: status.url,
        threadId,
        ...(lastFrameUrl !== undefined && { lastFrameUrl }),
        ...(status.expiresAt !== undefined && {
          expiresAt: status.expiresAt.toISOString(),
        }),
      }
    }
  }

  throw new Error(
    `Seedance job ${jobId} timed out after ${SEEDANCE_MAX_DURATION_MS / 60_000} minutes`,
  )
}

export { seedanceChatThreadId }
