/**
 * Client-safe Seedance chat tool *definitions* (schemas + names only).
 *
 * Server implementations live in `seedance-chat-tools.server.ts` so the
 * browser bundle never pulls in Ark polling / API keys.
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

/** Shared success payload every Seedance clip tool returns. */
export const seedanceClipOutputSchema = z.object({
  clipId: z
    .string()
    .describe('Stable id for this clip — pass it when remixing or extending'),
  jobId: z.string().describe('BytePlus Ark task id'),
  model: z.string(),
  mode: z.enum(['generate', 'remix', 'extend']),
  prompt: z.string().describe('The prompt that produced this clip'),
  videoUrl: z
    .string()
    .describe('HTTPS URL of the generated video (expires ~24h)'),
  lastFrameUrl: z
    .string()
    .optional()
    .describe(
      'Final frame PNG when available — required input for extend_clip',
    ),
  expiresAt: z
    .string()
    .optional()
    .describe('ISO timestamp when the video URL is expected to expire'),
  parentClipId: z
    .string()
    .optional()
    .describe('Prior clip this one was remixed/extended from, if any'),
  durationSeconds: z.number().optional(),
})

export type SeedanceClipOutput = z.infer<typeof seedanceClipOutputSchema>

const durationSchema = z
  .number()
  .int()
  .min(4)
  .max(15)
  .optional()
  .describe(
    'Clip length in whole seconds (4–15 on Seedance 2.0). Defaults to 5.',
  )

const sizeSchema = z
  .string()
  .optional()
  .describe(
    'Seedance size template: ratio or ratio_resolution, e.g. "16:9_720p". Defaults to 16:9_720p.',
  )

const generateAudioSchema = z
  .boolean()
  .optional()
  .describe(
    'When true, Seedance 2.0 generates a synchronized audio track. Default false.',
  )

export const generateClipToolDef = toolDefinition({
  name: 'generate_clip',
  description:
    'Create a brand-new Seedance video from a text prompt (text-to-video). ' +
    'Use this for the first shot in a session, or when the user wants a ' +
    'completely fresh clip rather than iterating on an existing one. ' +
    'Returns a clipId, videoUrl, and lastFrameUrl for later remix/extend.',
  inputSchema: z.object({
    prompt: z
      .string()
      .min(1)
      .describe('Detailed text description of the video to generate'),
    durationSeconds: durationSchema,
    size: sizeSchema,
    generateAudio: generateAudioSchema,
  }),
  outputSchema: seedanceClipOutputSchema,
})

export const remixClipToolDef = toolDefinition({
  name: 'remix_clip',
  description:
    'Iterate on an existing Seedance clip by feeding it back as a ' +
    'reference video (@Video1) with a new instruction. Prefer this when the ' +
    'user wants to keep the same subject/motion/style but change lighting, ' +
    'mood, setting, or other aspects. Requires the source clip videoUrl from ' +
    'a previous generate_clip / remix_clip / extend_clip result. ' +
    'Seedance 2.0 family only.',
  inputSchema: z.object({
    prompt: z
      .string()
      .min(1)
      .describe(
        'How to change the source clip. Mention @Video1 when referring to it, ' +
          'e.g. "Same subject as @Video1 but golden hour lighting".',
      ),
    sourceVideoUrl: z
      .string()
      .url()
      .describe('videoUrl of the clip to remix (from a prior tool result)'),
    parentClipId: z
      .string()
      .optional()
      .describe('clipId of the source clip, for the version stack'),
    durationSeconds: durationSchema,
    size: sizeSchema,
    generateAudio: generateAudioSchema,
  }),
  outputSchema: seedanceClipOutputSchema,
})

export const extendClipToolDef = toolDefinition({
  name: 'extend_clip',
  description:
    "Continue a shot by using a prior clip's last frame as the opening frame " +
    'of a new clip (first-frame conditioning). Use when the user wants the ' +
    'scene to keep going — panning further, action continuing, etc. Requires ' +
    'lastFrameUrl from a previous tool result. Do not mix with remix in one call.',
  inputSchema: z.object({
    prompt: z
      .string()
      .min(1)
      .describe(
        'What happens next in the shot, continuing from the previous last frame',
      ),
    sourceLastFrameUrl: z
      .string()
      .url()
      .describe(
        'lastFrameUrl of the clip to continue (from a prior tool result)',
      ),
    parentClipId: z
      .string()
      .optional()
      .describe('clipId of the source clip, for the version stack'),
    durationSeconds: durationSchema,
    size: sizeSchema,
    generateAudio: generateAudioSchema,
  }),
  outputSchema: seedanceClipOutputSchema,
})

export const listIterationModesToolDef = toolDefinition({
  name: 'list_iteration_modes',
  description:
    'Explain the available Seedance iteration modes and when to use each. ' +
    'Call this if the user asks how iteration works or you need a refresher.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    modes: z.array(
      z.object({
        name: z.string(),
        tool: z.string(),
        when: z.string(),
        requires: z.string(),
      }),
    ),
  }),
})

export const SEEDANCE_CHAT_SYSTEM_PROMPT = `You are a Seedance video director inside TanStack AI.

You help the user create and **iterate** on short videos using BytePlus Seedance 2.0 tools.

## Tools
- \`generate_clip\` — brand-new text-to-video. Use for the first clip or a full restart.
- \`remix_clip\` — feed a prior clip back as @Video1 and apply a new instruction (style, lighting, mood, setting). Prefer this for "make it more X" / "same scene but Y".
- \`extend_clip\` — open the next clip on the previous last frame so the shot continues.
- \`list_iteration_modes\` — explain the modes if asked.

## Workflow
1. Clarify briefly only if the request is ambiguous; otherwise call a tool.
2. After a tool returns, summarize what changed in 1–3 sentences and quote the clipId.
3. When the user wants changes, **reuse the latest clip's videoUrl / lastFrameUrl and clipId** from prior tool results — do not invent URLs.
4. Prefer remix for stylistic iterations; extend for temporal continuation; generate for unrelated new shots.
5. Default duration is 5 seconds, size 16:9_720p. Only change these when asked.
6. Video URLs expire about 24 hours after generation — warn if the user returns to a very old clip.

## Style
- Be concise and practical.
- Never claim a video exists without a successful tool result.
- Do not dump raw JSON; the UI already renders tool results as a version stack.`
