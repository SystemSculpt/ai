/**
 * Rewrite app-local media URLs so BytePlus Ark can consume them.
 *
 * Ark fetches `video_url` / `image_url` / `audio_url` server-side. It accepts
 * public HTTPS and (for images only) `data:` URIs — not relative paths like
 * `/api/artifacts?id=…` (our durable serve route).
 *
 * **Images** may be expanded from a durable artifact into inline base64.
 * **Video and audio may not** — Seedance rejects data URIs with
 * `reference_video must be provided as a web url`. For those modalities we
 * rehydrate the artifact's original provider `sourceUrl` (the Seedance TOS
 * link captured when the clip was persisted) and pass that through instead.
 */

import {
  retrieveArtifact,
  retrieveBlob,
} from '@tanstack/ai-persistence'
import type { MediaPrompt, MediaPromptPart } from '@tanstack/ai/client'
import { generationServerPersistence } from './generation-persistence'

/** Pull `id` out of `/api/artifacts?id=…` (absolute or relative). */
export function parseArtifactIdFromUrl(url: string): string | null {
  try {
    // Relative paths need a base; the host is irrelevant.
    const parsed = new URL(url, 'http://local.invalid')
    if (
      !parsed.pathname.endsWith('/api/artifacts') &&
      parsed.pathname !== '/api/artifacts'
    ) {
      // Allow trailing path variants
      if (!parsed.pathname.includes('/api/artifacts')) return null
    }
    const id = parsed.searchParams.get('id')
    return id && id.length > 0 ? id : null
  } catch {
    return null
  }
}

function isPublicHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !/localhost|127\.0\.0\.1/i.test(url)
}

function isRemoteVideoUrl(url: string): boolean {
  return isPublicHttpUrl(url) || url.startsWith('asset://')
}

/**
 * Expand one media part for Ark:
 * - public HTTPS / `asset://` → pass through
 * - durable `/api/artifacts` **image** → base64 data source
 * - durable `/api/artifacts` **video/audio** → original provider `sourceUrl`
 * - inline data for video/audio → reject (Seedance URL-only rule)
 */
export async function materializeMediaPartForArk(
  part: MediaPromptPart,
): Promise<MediaPromptPart> {
  if (part.type === 'text') return part

  // Already-inline data: images are fine; video/audio are not.
  if (part.source.type === 'data') {
    if (part.type === 'video' || part.type === 'audio') {
      throw new Error(
        `Seedance reference_${part.type} must be a public HTTPS URL (or ` +
          `asset:// id) — inline base64 is not accepted by Ark. Use the ` +
          `original Seedance output URL while it is still live, or host the ` +
          `file somewhere public.`,
      )
    }
    return part
  }

  const url = part.source.value
  if (isRemoteVideoUrl(url)) return part

  // data: URLs sometimes arrive as source.type 'url'.
  if (url.startsWith('data:')) {
    if (part.type === 'video' || part.type === 'audio') {
      throw new Error(
        `Seedance reference_${part.type} must be a public HTTPS URL — ` +
          `data: URIs are rejected by Ark.`,
      )
    }
    return part
  }

  const artifactId = parseArtifactIdFromUrl(url)
  if (!artifactId) {
    throw new Error(
      `Seedance needs a public HTTPS URL for ${part.type} references. ` +
        `"${url.slice(0, 80)}" is not reachable by BytePlus. Paste a public ` +
        `URL or use a clip that still has its original Seedance output URL.`,
    )
  }

  const persistence = generationServerPersistence()
  const artifact = await retrieveArtifact(persistence, artifactId)
  if (!artifact) {
    throw new Error(
      `Artifact ${artifactId} was not found in generation storage. ` +
        `Re-upload the media or paste a public URL.`,
    )
  }

  // Video / audio: rehydrate the original provider URL. Never base64.
  if (part.type === 'video' || part.type === 'audio') {
    const sourceUrl = artifact.sourceUrl
    if (!sourceUrl || !isRemoteVideoUrl(sourceUrl)) {
      throw new Error(
        `Clip ${artifactId} has no original Seedance URL on file (or it is ` +
          `not a public HTTPS link). Seedance will not accept the durable ` +
          `local copy as reference_${part.type}. Paste a public HTTPS URL ` +
          `while the provider link is still live, or host the file yourself.`,
      )
    }
    return {
      ...part,
      source: { type: 'url', value: sourceUrl },
    }
  }

  // Image: expand durable bytes into a data URI Seedance accepts inline.
  const blob = await retrieveBlob(persistence, artifact)
  if (!blob) {
    throw new Error(`No bytes stored for artifact ${artifactId}.`)
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const base64 = Buffer.from(bytes).toString('base64')

  return {
    ...part,
    source: {
      type: 'data',
      value: base64,
      mimeType: artifact.mimeType || 'application/octet-stream',
    },
  }
}

/** Expand every app-local media URL in a Seedance prompt for Ark. */
export async function materializeSeedancePromptForArk(
  prompt: MediaPrompt,
): Promise<MediaPrompt> {
  if (typeof prompt === 'string') return prompt
  return Promise.all(prompt.map((part) => materializeMediaPartForArk(part)))
}
