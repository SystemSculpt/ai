/**
 * Server implementations of the Seedance chat tools.
 * Import only from server routes — not from client components.
 */

import { runSeedanceJob, seedanceChatThreadId } from './seedance-run'
import {
  extendClipToolDef,
  generateClipToolDef,
  listIterationModesToolDef,
  remixClipToolDef,
} from './seedance-chat-tools'

function newClipId(): string {
  return `clip_${crypto.randomUUID().slice(0, 8)}`
}

export const generateClip = generateClipToolDef.server(async (args, ctx) => {
  const duration = args.durationSeconds ?? 5
  const size = args.size ?? '16:9_720p'
  // Allocate the clip id first so the generation run is filed under a stable
  // restore slot; the durable video URL then lands at /api/artifacts.
  const clipId = newClipId()
  const threadId = seedanceChatThreadId(clipId)

  ctx?.emitCustomEvent('seedance:progress', {
    phase: 'generate',
    message: `Generating new clip (${duration}s, ${size})…`,
    clipId,
  })

  const result = await runSeedanceJob({
    prompt: args.prompt.trim(),
    size,
    duration,
    threadId,
    modelOptions: {
      ...(args.generateAudio ? { generate_audio: true } : {}),
    },
    onStatus: (status, detail) => {
      ctx?.emitCustomEvent('seedance:progress', {
        phase: 'generate',
        status,
        message: detail ?? status,
        clipId,
      })
    },
  })

  return {
    clipId,
    jobId: result.jobId,
    model: result.model,
    mode: 'generate' as const,
    prompt: args.prompt,
    videoUrl: result.url,
    ...(result.lastFrameUrl !== undefined && {
      lastFrameUrl: result.lastFrameUrl,
    }),
    ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
    durationSeconds: duration,
  }
})

export const remixClip = remixClipToolDef.server(async (args, ctx) => {
  const duration = args.durationSeconds ?? 5
  const size = args.size ?? '16:9_720p'
  const promptText = args.prompt.includes('@Video1')
    ? args.prompt
    : `${args.prompt.trim()} (reference: @Video1)`
  const clipId = newClipId()
  const threadId = seedanceChatThreadId(clipId)

  ctx?.emitCustomEvent('seedance:progress', {
    phase: 'remix',
    message: `Remixing clip as @Video1 (${duration}s)…`,
    parentClipId: args.parentClipId,
    clipId,
  })

  const result = await runSeedanceJob({
    prompt: [
      {
        type: 'video',
        source: { type: 'url', value: args.sourceVideoUrl },
      },
      { type: 'text', content: promptText },
    ],
    size,
    duration,
    threadId,
    modelOptions: {
      ...(args.generateAudio ? { generate_audio: true } : {}),
    },
    onStatus: (status, detail) => {
      ctx?.emitCustomEvent('seedance:progress', {
        phase: 'remix',
        status,
        message: detail ?? status,
        parentClipId: args.parentClipId,
        clipId,
      })
    },
  })

  return {
    clipId,
    jobId: result.jobId,
    model: result.model,
    mode: 'remix' as const,
    prompt: promptText,
    videoUrl: result.url,
    ...(result.lastFrameUrl !== undefined && {
      lastFrameUrl: result.lastFrameUrl,
    }),
    ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
    ...(args.parentClipId !== undefined && {
      parentClipId: args.parentClipId,
    }),
    durationSeconds: duration,
  }
})

export const extendClip = extendClipToolDef.server(async (args, ctx) => {
  const duration = args.durationSeconds ?? 5
  const size = args.size ?? '16:9_720p'
  const clipId = newClipId()
  const threadId = seedanceChatThreadId(clipId)

  ctx?.emitCustomEvent('seedance:progress', {
    phase: 'extend',
    message: `Extending shot from last frame (${duration}s)…`,
    parentClipId: args.parentClipId,
    clipId,
  })

  const result = await runSeedanceJob({
    prompt: [
      {
        type: 'image',
        source: { type: 'url', value: args.sourceLastFrameUrl },
        metadata: { role: 'start_frame' },
      },
      { type: 'text', content: args.prompt },
    ],
    size,
    duration,
    threadId,
    modelOptions: {
      ...(args.generateAudio ? { generate_audio: true } : {}),
    },
    onStatus: (status, detail) => {
      ctx?.emitCustomEvent('seedance:progress', {
        phase: 'extend',
        status,
        message: detail ?? status,
        parentClipId: args.parentClipId,
        clipId,
      })
    },
  })

  return {
    clipId,
    jobId: result.jobId,
    model: result.model,
    mode: 'extend' as const,
    prompt: args.prompt,
    videoUrl: result.url,
    ...(result.lastFrameUrl !== undefined && {
      lastFrameUrl: result.lastFrameUrl,
    }),
    ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
    ...(args.parentClipId !== undefined && {
      parentClipId: args.parentClipId,
    }),
    durationSeconds: duration,
  }
})
export const listIterationModes = listIterationModesToolDef.server(() => ({
  modes: [
    {
      name: 'Generate',
      tool: 'generate_clip',
      when: 'First shot, or a completely new idea with no parent clip',
      requires: 'Text prompt only',
    },
    {
      name: 'Remix',
      tool: 'remix_clip',
      when: 'Keep subject/motion from an existing clip; change style, lighting, mood, setting',
      requires: 'sourceVideoUrl (+ optional parentClipId) from a prior result',
    },
    {
      name: 'Extend',
      tool: 'extend_clip',
      when: 'Continue the same shot past its current ending',
      requires: 'sourceLastFrameUrl (+ optional parentClipId) from a prior result',
    },
  ],
}))
