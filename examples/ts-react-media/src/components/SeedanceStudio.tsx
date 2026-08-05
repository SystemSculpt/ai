import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Dices,
  Download,
  GitBranch,
  Loader2,
  Music,
  RotateCcw,
  Send,
  Shuffle,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { useGenerateVideo } from '@tanstack/ai-react'
import type {
  BytePlusVideoModel,
  BytePlusVideoModelOrString,
  BytePlusVideoRatio,
  BytePlusVideoResolution,
} from '@tanstack/ai-byteplus'
import type { MediaPromptPart } from '@tanstack/ai/client'
import type { StreamChunk } from '@tanstack/ai'
import type { AttachedMedia } from '@/lib/media'
import type {
  SeedanceTemplate,
  SeedanceTemplateMedia,
} from '@/lib/seedance-templates'
import type { VideoBilling } from '@/lib/billing'
import type {
  SeedanceCapability,
  SeedanceInputMode,
  SeedanceJobOptions,
  SeedanceModelEntry,
} from '@/lib/seedance'

import {
  generateSeedanceVideoFn,
  getSeedanceHydrationFn,
  getSeedanceLastFrameFn,
  joinSeedanceRunFn,
} from '@/lib/server-functions'
import { SEEDANCE_STUDIO_THREAD_ID } from '@/lib/generation-ids'
import {
  mediaKindFromMime,
  mediaUrlToPart,
  readMediaFile,
  toAudioPart,
  toImagePart,
  toVideoPart,
} from '@/lib/media'
import { readVideoBilling } from '@/lib/billing'
import { getRandomVideoPrompt } from '@/lib/prompts'
import {
  SEEDANCE_CUSTOM_MODEL_PLACEHOLDER,
  SEEDANCE_FPS,
  SEEDANCE_MAX_FRAMES,
  SEEDANCE_MIN_FRAMES,
  SEEDANCE_MODELS,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTION_TIERS,
  SEEDANCE_UNKNOWN_MODEL_EXTRAS,
  seedanceModel,
  snapSeedanceFrames,
} from '@/lib/seedance'
import {
  SEEDANCE_TEMPLATES,
  SEEDANCE_TEMPLATE_MODEL,
  SEEDANCE_TEMPLATE_RESOLUTION,
} from '@/lib/seedance-templates'
import AutoGrowTextarea from '@/components/AutoGrowTextarea'

/** Reference images budget on Seedance 2.0 (studio soft cap). */
const MAX_REFERENCE_IMAGES = 4
/** Reference video / audio soft caps (Seedance 2.0 multimodal refs). */
const MAX_REFERENCE_VIDEOS = 3
const MAX_REFERENCE_AUDIOS = 3
const MIN_SEED = -1
const MAX_SEED = 2 ** 32 - 1

interface JobSettings {
  model: BytePlusVideoModelOrString
  ratio: BytePlusVideoRatio
  resolution: string
  duration: number | null
  frames: number | null
  seed: number | null
  serviceTier: 'default' | 'flex' | null
}

/**
 * One generation in the session timeline — same idea as OmniStudio turns.
 * The next prompt continues from a selected turn (remix/extend) instead of
 * living on a separate "chat" surface.
 */
interface SeedanceTurn {
  localId: string
  prompt: string
  /** How this turn was produced. */
  kind: 'generate' | 'remix' | 'extend' | 'reference' | 'first-frame'
  parentLocalId: string | null
  status: 'submitting' | 'processing' | 'completed' | 'error'
  jobId?: string
  /**
   * Durable app-origin URL (`/api/artifacts?id=…`) used for playback after
   * the provider link expires.
   */
  url?: string
  /**
   * Original Seedance/TOS output URL captured at generation time. Remix
   * defaults to this — Ark requires a public HTTPS `reference_video`, not
   * our durable local serve path or base64. Lives ~24h after the task
   * completes (`providerExpiresAt`).
   */
  providerUrl?: string
  /** ISO expiry of {@link SeedanceTurn.providerUrl}, when known. */
  providerExpiresAt?: string
  lastFrameUrl?: string
  error?: string
  settings?: JobSettings
}

/**
 * Pick the URL to send as the remix `reference_video` for a parent clip.
 *
 * Preference order:
 * 1. Original Seedance/TOS `providerUrl` while still live (best — public HTTPS).
 * 2. A non-artifact HTTPS `url` (persistence rewrite hasn't landed yet).
 * 3. Durable `/api/artifacts` URL — the server rehydrates the artifact's
 *    `sourceUrl` before calling Ark (same end result as 1 when the TOS
 *    link is still on file).
 *
 * Returns null only when we know the provider link is expired and there is
 * no durable fallback to try.
 */
function remixReferenceUrl(turn: SeedanceTurn): {
  url: string
  kind: 'provider' | 'durable'
} | null {
  const provider = turn.providerUrl?.trim()
  if (provider && /^https?:\/\//i.test(provider)) {
    if (turn.providerExpiresAt) {
      const expires = Date.parse(turn.providerExpiresAt)
      if (Number.isFinite(expires) && expires <= Date.now()) {
        // Fall through to durable so the server can still try sourceUrl if
        // the client clock/state is wrong — or fail with a clear message.
      } else {
        return { url: provider, kind: 'provider' }
      }
    } else {
      return { url: provider, kind: 'provider' }
    }
  }
  // Live provider link still on `url` (no persistence rewrite yet).
  if (
    turn.url &&
    /^https?:\/\//i.test(turn.url) &&
    !turn.url.includes('/api/artifacts')
  ) {
    return { url: turn.url, kind: 'provider' }
  }
  // Durable serve path — materialize-media swaps in sourceUrl server-side.
  if (turn.url && turn.url.includes('/api/artifacts')) {
    return { url: turn.url, kind: 'durable' }
  }
  return null
}

/** How the next prompt relates to the selected parent clip. */
type ContinueAction = 'remix' | 'extend'

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

async function* chunksFromSseResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  if (!response.ok) {
    throw new Error(
      `HTTP error! status: ${response.status} ${response.statusText}`,
    )
  }
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5)
        const data = raw.startsWith(' ') ? raw.slice(1) : raw
        if (!data || data === '[DONE]') continue
        try {
          yield JSON.parse(data) as StreamChunk
        } catch {
          // skip malformed chunk
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Seedance session UI modeled on OmniStudio: always start with a prompt,
 * every clip is a turn, the next prompt continues (remix / extend) from a
 * selected clip. No separate "chat app" — iteration *is* the prompt box.
 */
export default function SeedanceStudio({
  capabilities,
}: {
  capabilities: Array<SeedanceCapability>
}) {
  const [turns, setTurns] = useState<Array<SeedanceTurn>>([])
  const [prompt, setPrompt] = useState('')
  /** Parent turn for the next send; null = fresh generation. */
  const [continueFrom, setContinueFrom] = useState<string | null>(null)
  const [continueAction, setContinueAction] = useState<ContinueAction>('remix')
  /**
   * Optional remix source override. Remix defaults to the parent clip's
   * original Seedance output URL (public HTTPS, ~24h TTL). Paste another
   * public HTTPS URL here if that link has expired or you want a different
   * reference. File upload is not used for Ark (Seedance rejects base64
   * `reference_video`).
   */
  const [remixUrlOverride, setRemixUrlOverride] = useState('')

  // Fresh-generation conditioning (ignored while continuing a clip).
  const [inputMode, setInputMode] = useState<SeedanceInputMode>('text')
  const [firstFrame, setFirstFrame] = useState<AttachedMedia | null>(null)
  const [lastFrame, setLastFrame] = useState<AttachedMedia | null>(null)
  const [references, setReferences] = useState<Array<AttachedMedia>>([])
  const [templateMedia, setTemplateMedia] = useState<
    Array<SeedanceTemplateMedia>
  >([])
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(
    null,
  )
  const [showTemplates, setShowTemplates] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)

  const [modelId, setModelId] = useState<BytePlusVideoModel>(
    'dreamina-seedance-2-0-260128',
  )
  const [ratio, setRatio] = useState<BytePlusVideoRatio>('16:9')
  const [resolution, setResolution] = useState<BytePlusVideoResolution>('720p')
  const [duration, setDuration] = useState(5)
  const [autoDuration, setAutoDuration] = useState(false)
  const [useFrames, setUseFrames] = useState(false)
  const [frames, setFrames] = useState(121)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [customModelId, setCustomModelId] = useState('')
  const [customResolution, setCustomResolution] = useState('')
  const [seed, setSeed] = useState('')
  const [watermark, setWatermark] = useState(false)
  const [generateAudio, setGenerateAudio] = useState(false)
  const [cameraFixed, setCameraFixed] = useState(false)
  const [flexTier, setFlexTier] = useState(false)
  const [draft, setDraft] = useState(false)
  const [priority, setPriority] = useState(5)

  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [billing, setBilling] = useState<VideoBilling | undefined>(undefined)

  const firstFrameInputRef = useRef<HTMLInputElement>(null)
  const lastFrameInputRef = useRef<HTMLInputElement>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)

  const submissionRef = useRef<{
    localId: string
    model: BytePlusVideoModelOrString
    options: SeedanceJobOptions
    kind: SeedanceTurn['kind']
    parentLocalId: string | null
  } | null>(null)

  const customModel = customModelId.trim()
  const usingCustomId = showAdvanced && customModel.length > 0
  const activeModel: BytePlusVideoModelOrString = usingCustomId
    ? customModel
    : modelId
  const catalogEntry = usingCustomId ? undefined : seedanceModel(modelId)
  const unknownMode = catalogEntry === undefined
  const entry: SeedanceModelEntry = catalogEntry ?? {
    id: activeModel,
    name: activeModel,
    blurb: 'Custom model id — capabilities unverified',
    extras: SEEDANCE_UNKNOWN_MODEL_EXTRAS,
  }
  const capability = unknownMode
    ? undefined
    : capabilities.find((c) => c.model === modelId)
  const resolutions = unknownMode
    ? SEEDANCE_RESOLUTION_TIERS
    : (capability?.resolutions ?? [])
  const durationRange = capability?.duration ?? { min: 4, max: 12, step: 1 }
  const canLastFrame = unknownMode || (capability?.supportsLastFrame ?? false)
  const canReference =
    unknownMode || (capability?.supportsReferenceMedia ?? false)

  const effectiveDuration = unknownMode
    ? duration
    : Math.min(durationRange.max, Math.max(durationRange.min, duration))
  const effectiveFrames = snapSeedanceFrames(frames)
  const framesActive = entry.extras.frames && useFrames
  const autoDurationActive = entry.extras.autoDuration && autoDuration
  const requestResolution =
    unknownMode && customResolution.trim()
      ? customResolution.trim()
      : resolution
  const effectiveResolution = (
    unknownMode
      ? requestResolution
      : resolutions.includes(resolution)
        ? resolution
        : (resolutions[0] ?? '720p')
  ) as BytePlusVideoResolution

  // Continuing a clip forces 2.0-style reference / frame paths; fresh
  // conditioning only applies when starting a new shot.
  const isContinuing = continueFrom != null
  const effectiveMode: SeedanceInputMode = isContinuing
    ? continueAction === 'extend'
      ? 'first-frame'
      : 'reference'
    : inputMode === 'first-last-frame' && !canLastFrame
      ? 'first-frame'
      : inputMode === 'reference' && !canReference
        ? 'text'
        : inputMode

  const hasImageInput =
    !isContinuing &&
    (effectiveMode === 'first-frame' ||
      effectiveMode === 'first-last-frame' ||
      (effectiveMode === 'reference' &&
        (references.length > 0 || templateMedia.length > 0)))
  const effectiveRatio: BytePlusVideoRatio =
    ratio === 'adaptive' && !hasImageInput && !isContinuing ? '16:9' : ratio

  const continueFromTurn = continueFrom
    ? turns.find((t) => t.localId === continueFrom)
    : undefined
  const continueFromIndex = continueFromTurn
    ? turns.indexOf(continueFromTurn) + 1
    : null

  const updateTurn = (localId: string, patch: Partial<SeedanceTurn>) => {
    setTurns((prev) =>
      prev.map((turn) =>
        turn.localId === localId ? { ...turn, ...patch } : turn,
      ),
    )
  }

  const { generate, isLoading, jobId, videoStatus, result, status } =
    useGenerateVideo({
      // One stable slot for the whole studio session. Hydration looks up the
      // latest run for this id — it must match the threadId on every generate.
      threadId: SEEDANCE_STUDIO_THREAD_ID,
      persistence: true,
      hydrateGeneration: (id) => getSeedanceHydrationFn({ data: id }),
      joinRun: async function* (runId, signal) {
        const response = await joinSeedanceRunFn({ data: runId })
        yield* chunksFromSseResponse(response as Response, signal)
      },
      fetcher: (input, options) => {
        const submission = submissionRef.current
        if (!submission) throw new Error('No Seedance turn in flight')
        return generateSeedanceVideoFn({
          data: {
            prompt: input.prompt,
            model: submission.model,
            options: submission.options,
            threadId: SEEDANCE_STUDIO_THREAD_ID,
          },
          signal: options?.signal,
        })
      },
      onJobCreated: (createdJobId) => {
        const submission = submissionRef.current
        if (!submission) return
        updateTurn(submission.localId, {
          status: 'processing',
          jobId: createdJobId,
        })
      },
      onResult: (videoResult) => {
        const submission = submissionRef.current
        if (!submission) return
        const localId = submission.localId
        const job = videoResult.jobId
        // Persistence rewrites `url` to `/api/artifacts` for durable playback.
        // The original Seedance TOS link is kept on the artifact's sourceUrl
        // (and as expiresAt on the result) so remix can send a public HTTPS
        // reference_video while the link is still live.
        const videoArtifact = videoResult.artifacts?.find(
          (a) =>
            a.source?.mediaType === 'video' ||
            a.mimeType.startsWith('video/') ||
            a.source?.path === 'video',
        )
        const providerUrl =
          videoArtifact?.sourceUrl ??
          (videoResult.url &&
          /^https?:\/\//i.test(videoResult.url) &&
          !videoResult.url.includes('/api/artifacts')
            ? videoResult.url
            : undefined)
        const providerExpiresAt =
          videoResult.expiresAt instanceof Date
            ? videoResult.expiresAt.toISOString()
            : typeof videoResult.expiresAt === 'string'
              ? videoResult.expiresAt
              : videoArtifact?.source?.expiresAt
        updateTurn(localId, {
          status: 'completed',
          url: videoResult.url,
          jobId: job,
          ...(providerUrl ? { providerUrl } : {}),
          ...(providerExpiresAt ? { providerExpiresAt } : {}),
        })
        // Pull last-frame for extend chaining (async; turn already completed).
        if (job) {
          void getSeedanceLastFrameFn({ data: job }).then((extras) => {
            if (extras.lastFrameUrl) {
              updateTurn(localId, { lastFrameUrl: extras.lastFrameUrl })
            }
          })
        }
        // Auto-select this turn as the parent for the next prompt.
        setContinueFrom(localId)
        setContinueAction('remix')
        submissionRef.current = null
        setStartedAt(null)
      },
      onError: (err) => {
        const submission = submissionRef.current
        if (submission) {
          updateTurn(submission.localId, {
            status: 'error',
            error: err.message,
          })
        }
        submissionRef.current = null
        setStartedAt(null)
      },
      onChunk: (chunk) => {
        const usage = readVideoBilling(chunk)
        if (usage) setBilling(usage)
      },
    })

  const isBusy = isLoading

  // Hydration restores the hook's `result`, but the timeline is our own
  // React state. On first paint after a reload, seed a single completed turn
  // from the restored video so the last clip shows up again.
  const seededFromHydrationRef = useRef(false)
  useEffect(() => {
    if (seededFromHydrationRef.current) return
    if (turns.length > 0) return
    if (isLoading || submissionRef.current) return
    if (!result?.url) return
    // Only adopt a finished restore — ignore transient states.
    if (status !== 'success' && status !== 'idle') return

    seededFromHydrationRef.current = true
    const localId = crypto.randomUUID()
    const restoredJobId = result.jobId ?? jobId ?? undefined
    const videoArtifact = result.artifacts?.find(
      (a) =>
        a.source?.mediaType === 'video' ||
        a.mimeType?.startsWith('video/') ||
        a.source?.path === 'video',
    )
    const providerUrl =
      videoArtifact?.sourceUrl ??
      (result.url &&
      /^https?:\/\//i.test(result.url) &&
      !result.url.includes('/api/artifacts')
        ? result.url
        : undefined)
    const providerExpiresAt =
      result.expiresAt instanceof Date
        ? result.expiresAt.toISOString()
        : typeof result.expiresAt === 'string'
          ? result.expiresAt
          : videoArtifact?.source?.expiresAt
    setTurns([
      {
        localId,
        prompt: 'Restored from last session',
        kind: 'generate',
        parentLocalId: null,
        status: 'completed',
        url: result.url,
        ...(restoredJobId ? { jobId: restoredJobId } : {}),
        ...(providerUrl ? { providerUrl } : {}),
        ...(providerExpiresAt ? { providerExpiresAt } : {}),
      },
    ])
    setContinueFrom(localId)
    setContinueAction('remix')
    if (restoredJobId) {
      void getSeedanceLastFrameFn({ data: restoredJobId }).then((extras) => {
        if (extras.lastFrameUrl) {
          setTurns((prev) =>
            prev.map((t) =>
              t.localId === localId
                ? { ...t, lastFrameUrl: extras.lastFrameUrl }
                : t,
            ),
          )
        }
      })
    }
  }, [result, jobId, isLoading, status, turns.length])

  useEffect(() => {
    if (!isBusy) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [isBusy])

  const attachFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
    apply: (media: AttachedMedia) => void,
  ) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    setAttachError(null)
    try {
      for (const file of files) {
        apply(await readMediaFile(file))
      }
    } catch (error) {
      setAttachError(
        `Could not read file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const applyTemplate = (template: SeedanceTemplate) => {
    if (isBusy) return
    setContinueFrom(null)
    setModelId(SEEDANCE_TEMPLATE_MODEL)
    setCustomModelId('')
    setShowAdvanced(false)
    setPrompt(template.prompt)
    setInputMode('reference')
    setTemplateMedia(template.media)
    setReferences([])
    setAppliedTemplateId(template.id)
    setSeed('')
    setAutoDuration(true)
    setGenerateAudio(true)
    setResolution(SEEDANCE_TEMPLATE_RESOLUTION)
    setRatio('adaptive')
  }

  const handlePromptChange = (value: string) => {
    setPrompt(value)
    if (appliedTemplateId !== null) setAppliedTemplateId(null)
  }

  const buildOptions = (): {
    options: SeedanceJobOptions
    settings: JobSettings
  } => {
    const parsedSeed = seed.trim() === '' ? null : Number(seed)
    const seedValue =
      parsedSeed !== null && Number.isFinite(parsedSeed)
        ? Math.min(MAX_SEED, Math.max(MIN_SEED, Math.trunc(parsedSeed)))
        : null

    const settings: JobSettings = {
      model: activeModel,
      ratio: effectiveRatio,
      resolution: requestResolution,
      duration: framesActive
        ? null
        : autoDurationActive
          ? -1
          : effectiveDuration,
      frames: framesActive ? effectiveFrames : null,
      seed: seedValue,
      serviceTier: entry.extras.serviceTier
        ? flexTier
          ? 'flex'
          : 'default'
        : null,
    }

    const options: SeedanceJobOptions = {
      ...(unknownMode
        ? { size: `${effectiveRatio}_${requestResolution}` }
        : { ratio: effectiveRatio, resolution: effectiveResolution }),
      ...(framesActive
        ? { frames: effectiveFrames }
        : { duration: autoDurationActive ? -1 : effectiveDuration }),
      ...(seedValue !== null && { seed: seedValue }),
      watermark,
      ...(entry.extras.generateAudio && { generateAudio }),
      ...(entry.extras.cameraFixed && { cameraFixed }),
      ...(entry.extras.serviceTier && {
        serviceTier: flexTier ? 'flex' : 'default',
      }),
      ...(entry.extras.draft && { draft }),
      ...(entry.extras.priority && {
        priority: Math.min(9, Math.max(0, Math.trunc(priority))),
      }),
    }

    return { options, settings }
  }

  const handleSend = async () => {
    if (!prompt.trim() || isBusy || submissionRef.current) return

    const localId = crypto.randomUUID()
    const parent = continueFromTurn
    let kind: SeedanceTurn['kind'] = 'generate'
    const parts: Array<MediaPromptPart> = []

    if (parent && continueAction === 'remix') {
      kind = 'remix'
      // Seedance requires a public HTTPS reference_video. Prefer an explicit
      // override, else the parent clip's original Seedance output URL. A
      // durable `/api/artifacts` fallback is resolved server-side to that
      // same provider sourceUrl (never base64 — Ark 400s data URIs).
      const override = remixUrlOverride.trim()
      const resolved = override
        ? { url: override, kind: 'provider' as const }
        : remixReferenceUrl(parent)
      if (!resolved) {
        setAttachError(
          parent.providerExpiresAt &&
            Date.parse(parent.providerExpiresAt) <= Date.now()
            ? `Clip #${turns.indexOf(parent) + 1}'s Seedance URL expired ` +
                `(~24h after generation). Paste a public HTTPS URL of the ` +
                `clip to remix it.`
            : 'No public Seedance URL for this clip — paste a public HTTPS ' +
                'video URL to use as the remix reference.',
        )
        return
      }
      if (
        !/^https?:\/\//i.test(resolved.url) &&
        !resolved.url.startsWith('asset://') &&
        !resolved.url.includes('/api/artifacts')
      ) {
        setAttachError(
          'Remix reference must be a public HTTPS URL (or asset:// id).',
        )
        return
      }
      parts.push({
        type: 'video',
        source: { type: 'url', value: resolved.url },
      })
      const text = prompt.includes('@Video1')
        ? prompt
        : `${prompt.trim()} (reference: @Video1)`
      parts.push({ type: 'text', content: text })
    } else if (parent && continueAction === 'extend') {
      kind = 'extend'
      const frameUrl = parent.lastFrameUrl
      if (!frameUrl) {
        setAttachError(
          'No last frame for this clip yet — try Remix, or wait a moment after generation for the frame to arrive.',
        )
        return
      }
      parts.push({
        type: 'image',
        source: { type: 'url', value: frameUrl },
        metadata: { role: 'start_frame' },
      })
      parts.push({ type: 'text', content: prompt })
    } else if (
      effectiveMode === 'first-frame' ||
      effectiveMode === 'first-last-frame'
    ) {
      kind = 'first-frame'
      if (prompt.trim()) parts.push({ type: 'text', content: prompt })
      if (firstFrame)
        parts.push(toImagePart(firstFrame, { role: 'start_frame' }))
      if (effectiveMode === 'first-last-frame' && lastFrame) {
        parts.push(toImagePart(lastFrame, { role: 'end_frame' }))
      }
    } else if (effectiveMode === 'reference') {
      kind = 'reference'
      if (prompt.trim()) parts.push({ type: 'text', content: prompt })
      for (const media of templateMedia) {
        parts.push(mediaUrlToPart(media.kind, media.url, { role: 'reference' }))
      }
      for (const ref of references) {
        const k = mediaKindFromMime(ref.mimeType)
        if (k === 'video') parts.push(toVideoPart(ref))
        else if (k === 'audio') parts.push(toAudioPart(ref))
        else parts.push(toImagePart(ref, { role: 'reference' }))
      }
    } else {
      kind = 'generate'
      parts.push({ type: 'text', content: prompt })
    }

    if (parts.length === 0) return

    // Remix / multimodal refs need Seedance 2.0; bump if still on a 1.x model.
    let modelForJob = activeModel
    if (
      (kind === 'remix' || kind === 'reference') &&
      !unknownMode &&
      !canReference
    ) {
      modelForJob = 'dreamina-seedance-2-0-260128'
      setModelId('dreamina-seedance-2-0-260128')
    }

    const { options, settings } = buildOptions()
    if (modelForJob !== activeModel) {
      settings.model = modelForJob
    }

    setTurns((prev) => [
      ...prev,
      {
        localId,
        prompt,
        kind,
        parentLocalId: parent?.localId ?? null,
        status: 'submitting',
        settings,
      },
    ])
    setPrompt('')
    setRemixUrlOverride('')
    setAttachError(null)
    setBilling(undefined)
    setStartedAt(Date.now())

    submissionRef.current = {
      localId,
      model: modelForJob,
      options,
      kind,
      parentLocalId: parent?.localId ?? null,
    }

    await generate({
      prompt: parts.length === 1 ? prompt : parts,
    })
  }

  const restoreTurn = (turn: SeedanceTurn) => {
    setPrompt(turn.prompt)
    setContinueFrom(turn.parentLocalId)
    setTurns((prev) => prev.filter((t) => t.localId !== turn.localId))
  }

  // Reference budgets by modality.
  const refImages = references.filter(
    (r) => mediaKindFromMime(r.mimeType) === 'image',
  )
  const refVideos = references.filter(
    (r) => mediaKindFromMime(r.mimeType) === 'video',
  )
  const refAudios = references.filter(
    (r) => mediaKindFromMime(r.mimeType) === 'audio',
  )
  const templateImageCount = templateMedia.filter(
    (m) => m.kind === 'image',
  ).length
  const imagesLeft = Math.max(
    0,
    MAX_REFERENCE_IMAGES - templateImageCount - refImages.length,
  )
  const videosLeft = Math.max(0, MAX_REFERENCE_VIDEOS - refVideos.length)
  const audiosLeft = Math.max(0, MAX_REFERENCE_AUDIOS - refAudios.length)

  const modeOptions: Array<{
    value: SeedanceInputMode
    label: string
    enabled: boolean
  }> = [
    { value: 'text', label: 'Text only', enabled: true },
    {
      value: 'first-frame',
      label: 'First frame',
      enabled: true,
    },
    {
      value: 'first-last-frame',
      label: 'First + last',
      enabled: canLastFrame,
    },
    {
      value: 'reference',
      label: 'References',
      enabled: canReference,
    },
  ]

  const canSend = Boolean(prompt.trim()) && !isBusy

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-cyan-500/10 border border-cyan-500/20 rounded-lg">
        <Sparkles className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
        <p className="text-sm text-gray-300">
          Start with a prompt — every clip is a turn. After a clip finishes,
          the next prompt{' '}
          <span className="text-cyan-300">continues from it</span> (remix via
          reference video, or extend from the last frame). Same pattern as Omni
          Studio; no separate chat surface.
        </p>
      </div>

      {/* Timeline */}
      {turns.length > 0 && (
        <div className="space-y-4">
          {turns.map((turn, i) => {
            const parentPosition = turn.parentLocalId
              ? turns.findIndex((t) => t.localId === turn.parentLocalId)
              : -1
            const selected = turn.localId === continueFrom
            return (
              <div
                key={turn.localId}
                className={`border-l-2 pl-4 space-y-2 ${
                  selected ? 'border-cyan-500' : 'border-gray-700'
                }`}
              >
                <div className="p-3 bg-gray-800 rounded-lg border border-gray-700">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-1">
                    <span className="font-medium text-gray-400">
                      Clip #{i + 1}
                    </span>
                    <span className="uppercase tracking-wide text-[10px] px-1.5 py-0.5 rounded border border-gray-600 text-gray-400">
                      {turn.kind}
                    </span>
                    {parentPosition >= 0 && (
                      <span className="flex items-center gap-1 text-cyan-400">
                        <GitBranch className="w-3 h-3" />
                        from #{parentPosition + 1}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-200 whitespace-pre-wrap">
                    {turn.prompt}
                  </p>
                </div>

                {(turn.status === 'submitting' ||
                  turn.status === 'processing') && (
                  <div className="flex items-center gap-2 p-4 bg-gray-800 rounded-lg border border-gray-700">
                    <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
                    <span className="text-gray-400">
                      {turn.status === 'submitting'
                        ? 'Submitting…'
                        : videoStatus?.status === 'processing'
                          ? 'Processing…'
                          : 'Queued…'}
                    </span>
                    {startedAt && (
                      <span className="flex items-center gap-1 text-sm text-gray-500">
                        <Clock className="w-3.5 h-3.5" />
                        {formatElapsed(now - startedAt)}
                      </span>
                    )}
                    {jobId && (
                      <span className="text-xs text-gray-600 font-mono truncate">
                        {jobId}
                      </span>
                    )}
                  </div>
                )}

                {turn.status === 'error' && (
                  <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg space-y-2">
                    <p className="text-red-400 text-sm">{turn.error}</p>
                    <button
                      type="button"
                      onClick={() => restoreTurn(turn)}
                      className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-red-300 hover:text-red-200 bg-red-500/10 hover:bg-red-500/20 rounded-md"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Edit & retry
                    </button>
                  </div>
                )}

                {turn.status === 'completed' && turn.url && (
                  <div className="space-y-2">
                    <div className="rounded-lg overflow-hidden border border-gray-700">
                      <video
                        src={turn.url}
                        controls
                        autoPlay={selected}
                        loop
                        className="w-full h-auto"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <a
                        href={turn.url}
                        download
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded-md"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {turn.url.startsWith('/api/artifacts')
                          ? 'Open durable clip'
                          : 'Download'}
                      </a>
                      {!selected && (
                        <button
                          type="button"
                          onClick={() => {
                            setContinueFrom(turn.localId)
                            setContinueAction('remix')
                          }}
                          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-cyan-400 hover:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 rounded-md"
                        >
                          <GitBranch className="w-3.5 h-3.5" />
                          Continue from here
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Composer — always the extension of "prompt" */}
      <div className="space-y-4 p-4 bg-gray-800/60 border border-gray-700 rounded-xl">
        {continueFromIndex != null && continueFromTurn && (
          <div className="space-y-3 px-3 py-3 bg-cyan-500/10 border border-cyan-500/20 rounded-lg">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-sm text-cyan-200 flex items-center gap-2">
                <GitBranch className="w-4 h-4 shrink-0" />
                Continuing clip #{continueFromIndex}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex p-0.5 rounded-lg bg-gray-900/60 border border-gray-700 gap-0.5">
                  <button
                    type="button"
                    onClick={() => setContinueAction('remix')}
                    className={`px-2.5 py-1 text-xs rounded-md ${
                      continueAction === 'remix'
                        ? 'bg-violet-600 text-white'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    Remix
                  </button>
                  <button
                    type="button"
                    onClick={() => setContinueAction('extend')}
                    disabled={!continueFromTurn.lastFrameUrl}
                    title={
                      continueFromTurn.lastFrameUrl
                        ? 'Open next clip on the previous last frame'
                        : 'Last frame not available yet'
                    }
                    className={`px-2.5 py-1 text-xs rounded-md disabled:opacity-40 ${
                      continueAction === 'extend'
                        ? 'bg-sky-600 text-white'
                        : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    Extend
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setContinueFrom(null)
                    setRemixUrlOverride('')
                  }}
                  className="text-xs text-gray-400 hover:text-white underline"
                >
                  Start a new shot
                </button>
              </div>
            </div>

            {continueAction === 'remix' && continueFromTurn && (
              <div className="space-y-2 pt-1 border-t border-cyan-500/15">
                {(() => {
                  const defaultRef = remixReferenceUrl(continueFromTurn)
                  const expired =
                    !!continueFromTurn.providerUrl &&
                    !!continueFromTurn.providerExpiresAt &&
                    Date.parse(continueFromTurn.providerExpiresAt) <= Date.now()
                  return (
                    <p className="text-xs text-cyan-100/70">
                      Reference video for Ark:{' '}
                      {defaultRef?.kind === 'provider' ? (
                        <>
                          defaults to clip #{continueFromIndex}&apos;s{' '}
                          <strong className="font-medium text-cyan-100">
                            original Seedance output URL
                          </strong>
                          {continueFromTurn.providerExpiresAt
                            ? ` (live until ${new Date(
                                continueFromTurn.providerExpiresAt,
                              ).toLocaleString()})`
                            : ' (~24h after generation)'}
                          . Paste another public HTTPS URL to override.
                        </>
                      ) : defaultRef?.kind === 'durable' ? (
                        <>
                          defaults to clip #{continueFromIndex}&apos;s stored
                          Seedance source URL (rehydrated from durable
                          storage
                          {expired ? ', link may have expired' : ''}). Paste a
                          public HTTPS URL if remix fails.
                        </>
                      ) : (
                        <>
                          no Seedance URL on file for clip #
                          {continueFromIndex}. Paste a public HTTPS video URL
                          below.
                        </>
                      )}
                    </p>
                  )
                })()}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={remixUrlOverride}
                    onChange={(e) => setRemixUrlOverride(e.target.value)}
                    placeholder="https://… public video URL (optional override)"
                    disabled={isBusy}
                    className="flex-1 px-3 py-2 bg-gray-900/70 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
                  />
                  {remixUrlOverride.trim() && (
                    <button
                      type="button"
                      onClick={() => setRemixUrlOverride('')}
                      className="text-xs text-gray-400 hover:text-white underline px-1"
                    >
                      Use clip #{continueFromIndex}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium text-gray-300">Prompt</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowTemplates((o) => !o)}
              disabled={isBusy}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md ${
                showTemplates || appliedTemplateId
                  ? 'text-cyan-300 bg-cyan-500/15'
                  : 'text-gray-400 bg-gray-700/50 hover:text-gray-200'
              }`}
            >
              {showTemplates ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              Templates
            </button>
            <button
              type="button"
              onClick={() =>
                handlePromptChange(
                  getRandomVideoPrompt(
                    isContinuing || hasImageInput
                      ? 'image-to-video'
                      : 'text-to-video',
                  ),
                )
              }
              disabled={isBusy}
              className="flex items-center gap-1 px-2 py-1 text-xs text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md disabled:opacity-50"
            >
              <Shuffle className="w-3.5 h-3.5" />
              Shuffle
            </button>
          </div>
        </div>

        <AutoGrowTextarea
          value={prompt}
          onChange={handlePromptChange}
          minRows={3}
          maxRows={16}
          disabled={isBusy}
          placeholder={
            isContinuing
              ? continueAction === 'extend'
                ? 'What happens next in the shot…'
                : 'How should this clip change? (lighting, mood, setting…)'
              : 'Describe the shot — quote any dialogue for the audio track…'
          }
          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm leading-relaxed disabled:opacity-50"
        />

        {showTemplates && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 pt-1">
            {SEEDANCE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => applyTemplate(template)}
                disabled={isBusy}
                className={`text-left rounded-lg border p-2 text-xs transition-colors disabled:opacity-50 ${
                  appliedTemplateId === template.id
                    ? 'border-cyan-500 bg-cyan-500/10'
                    : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                }`}
              >
                <div className="font-medium text-white">{template.name}</div>
                <div className="text-gray-400 mt-0.5 line-clamp-2">
                  {template.blurb}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Fresh-shot conditioning only when not continuing */}
        {!isContinuing && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {modeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setInputMode(option.value)}
                  disabled={isBusy || !option.enabled}
                  className={`px-3 py-1.5 text-sm rounded-md disabled:opacity-40 ${
                    effectiveMode === option.value
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {(effectiveMode === 'first-frame' ||
              effectiveMode === 'first-last-frame') && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FramePicker
                  label="First frame"
                  media={firstFrame}
                  disabled={isBusy}
                  onPick={() => firstFrameInputRef.current?.click()}
                  onClear={() => setFirstFrame(null)}
                />
                {effectiveMode === 'first-last-frame' && (
                  <FramePicker
                    label="Last frame"
                    media={lastFrame}
                    disabled={isBusy}
                    onPick={() => lastFrameInputRef.current?.click()}
                    onClear={() => setLastFrame(null)}
                  />
                )}
              </div>
            )}

            {effectiveMode === 'reference' && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">
                  Images, video, and audio references (Seedance 2.0). Audio
                  needs at least one visual ref.
                </p>
                {templateMedia.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {templateMedia.map((media) => (
                      <div
                        key={media.url}
                        className="relative w-16 h-16 rounded-lg border border-cyan-700/50 overflow-hidden bg-gray-900"
                      >
                        {media.kind === 'image' ? (
                          <img
                            src={media.url}
                            alt={media.label}
                            className="w-full h-full object-cover"
                          />
                        ) : media.kind === 'video' ? (
                          <video
                            src={media.url}
                            muted
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="flex items-center justify-center h-full text-cyan-400">
                            <Music className="w-5 h-5" />
                          </div>
                        )}
                        <span className="absolute bottom-0 inset-x-0 text-[9px] bg-black/70 text-center text-gray-300 truncate px-0.5">
                          {media.label}
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setTemplateMedia([])
                        setAppliedTemplateId(null)
                      }}
                      className="text-xs text-gray-400 underline"
                    >
                      Clear template media
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 items-center">
                  {references.map((ref) => {
                    const k = mediaKindFromMime(ref.mimeType)
                    return (
                      <div key={ref.id} className="relative">
                        {k === 'image' ? (
                          <img
                            src={ref.dataUrl}
                            alt={ref.name}
                            className="w-16 h-16 object-cover rounded-lg border border-gray-600"
                          />
                        ) : k === 'video' ? (
                          <video
                            src={ref.dataUrl}
                            muted
                            className="w-16 h-16 object-cover rounded-lg border border-gray-600"
                          />
                        ) : (
                          <div
                            title={ref.name}
                            className="w-16 h-16 flex flex-col items-center justify-center rounded-lg border border-gray-600 bg-gray-900 text-gray-400"
                          >
                            <Music className="w-5 h-5" />
                            <span className="text-[9px] mt-0.5 truncate max-w-[3.5rem] px-0.5">
                              audio
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setReferences((prev) =>
                              prev.filter((m) => m.id !== ref.id),
                            )
                          }
                          disabled={isBusy}
                          className="absolute -top-1.5 -right-1.5 p-0.5 bg-gray-900 hover:bg-gray-700 rounded-full text-white border border-gray-600"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )
                  })}
                  {(imagesLeft > 0 || videosLeft > 0 || audiosLeft > 0) && (
                    <button
                      type="button"
                      onClick={() => referenceInputRef.current?.click()}
                      disabled={isBusy}
                      className="flex flex-col items-center justify-center w-16 h-16 border-2 border-dashed border-gray-600 hover:border-gray-500 rounded-lg text-gray-500 hover:text-gray-400 disabled:opacity-50"
                      title="Add image, video, or audio references"
                    >
                      <Upload className="w-4 h-4" />
                      <span className="text-[10px] mt-0.5">Add</span>
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gray-600">
                  Slots left — images {imagesLeft}/{MAX_REFERENCE_IMAGES},
                  video {videosLeft}/{MAX_REFERENCE_VIDEOS}, audio {audiosLeft}/
                  {MAX_REFERENCE_AUDIOS}
                </p>
              </div>
            )}

            <input
              ref={firstFrameInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => attachFile(e, setFirstFrame)}
            />
            <input
              ref={lastFrameInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => attachFile(e, setLastFrame)}
            />
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              className="hidden"
              onChange={(e) =>
                attachFile(e, (media) => {
                  const k = mediaKindFromMime(media.mimeType)
                  setReferences((prev) => {
                    const imgs = prev.filter(
                      (m) => mediaKindFromMime(m.mimeType) === 'image',
                    )
                    const vids = prev.filter(
                      (m) => mediaKindFromMime(m.mimeType) === 'video',
                    )
                    const auds = prev.filter(
                      (m) => mediaKindFromMime(m.mimeType) === 'audio',
                    )
                    if (
                      k === 'image' &&
                      imgs.length >= MAX_REFERENCE_IMAGES - templateImageCount
                    )
                      return prev
                    if (k === 'video' && vids.length >= MAX_REFERENCE_VIDEOS)
                      return prev
                    if (k === 'audio' && auds.length >= MAX_REFERENCE_AUDIOS)
                      return prev
                    return [...prev, media]
                  })
                })
              }
            />
          </div>
        )}

        {attachError && (
          <p
            role="alert"
            className="text-sm text-red-400 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2"
          >
            {attachError}
          </p>
        )}

        {/* Compact options */}
        <div className="border-t border-gray-700 pt-3 space-y-3">
          <button
            type="button"
            onClick={() => setShowOptions((o) => !o)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            {showOptions ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Model & output options
            <span className="text-xs text-gray-600 font-mono ml-1">
              {entry.name} · {effectiveRatio} · {requestResolution}
            </span>
          </button>

          {showOptions && (
            <div className="space-y-4 pl-1">
              <div className="space-y-2">
                <select
                  value={unknownMode ? '' : modelId}
                  onChange={(e) => {
                    const picked = SEEDANCE_MODELS.find(
                      (m) => m.id === e.target.value,
                    )
                    if (picked) setModelId(picked.id)
                  }}
                  disabled={isBusy || usingCustomId}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white disabled:opacity-50"
                >
                  {unknownMode && (
                    <option value="">Custom: {activeModel}</option>
                  )}
                  {SEEDANCE_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
                {catalogEntry && !unknownMode && (
                  <p className="text-xs text-gray-500">{catalogEntry.blurb}</p>
                )}
                <button
                  type="button"
                  onClick={() => setShowAdvanced((p) => !p)}
                  className="text-xs text-gray-500 hover:text-gray-300"
                >
                  {showAdvanced ? 'Hide' : 'Custom model id…'}
                </button>
                {showAdvanced && (
                  <input
                    type="text"
                    value={customModelId}
                    onChange={(e) => setCustomModelId(e.target.value)}
                    placeholder={SEEDANCE_CUSTOM_MODEL_PLACEHOLDER}
                    disabled={isBusy}
                    spellCheck={false}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm font-mono text-white"
                  />
                )}
                {unknownMode && (
                  <div className="flex gap-2 text-xs text-amber-200/90 p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    Unverified model — options ungated; Ark validates.
                  </div>
                )}
              </div>

              <Control label="Aspect ratio">
                <div className="flex flex-wrap gap-1">
                  {SEEDANCE_RATIOS.map((option) => (
                    <ChoiceButton
                      key={option}
                      selected={effectiveRatio === option}
                      disabled={isBusy}
                      onClick={() => setRatio(option)}
                    >
                      {option}
                    </ChoiceButton>
                  ))}
                  {(hasImageInput || isContinuing) && (
                    <ChoiceButton
                      selected={effectiveRatio === 'adaptive'}
                      disabled={isBusy}
                      onClick={() => setRatio('adaptive')}
                    >
                      adaptive
                    </ChoiceButton>
                  )}
                </div>
              </Control>

              <Control label="Resolution">
                <div className="flex flex-wrap gap-1">
                  {resolutions.map((option) => (
                    <ChoiceButton
                      key={option}
                      selected={requestResolution === option}
                      disabled={isBusy}
                      onClick={() => {
                        setResolution(option)
                        setCustomResolution('')
                      }}
                    >
                      {option}
                    </ChoiceButton>
                  ))}
                </div>
              </Control>

              <Control
                label="Length"
                hint={
                  framesActive
                    ? `${effectiveFrames} frames`
                    : autoDurationActive
                      ? 'model chooses'
                      : `${effectiveDuration}s`
                }
              >
                <div className="flex flex-wrap items-center gap-3">
                  {!framesActive && !unknownMode && (
                    <input
                      type="range"
                      min={durationRange.min}
                      max={durationRange.max}
                      step={durationRange.step}
                      value={effectiveDuration}
                      disabled={isBusy || autoDurationActive}
                      onChange={(e) => setDuration(Number(e.target.value))}
                      className="w-40 accent-cyan-500 disabled:opacity-50"
                    />
                  )}
                  {entry.extras.autoDuration && (
                    <Toggle
                      label="Auto length"
                      hint="duration: -1"
                      checked={autoDurationActive}
                      disabled={isBusy || framesActive}
                      onChange={setAutoDuration}
                    />
                  )}
                  {entry.extras.frames && (
                    <Toggle
                      label="Frame count"
                      hint={`${SEEDANCE_FPS} fps`}
                      checked={framesActive}
                      disabled={isBusy}
                      onChange={setUseFrames}
                    />
                  )}
                  {framesActive && (
                    <input
                      type="range"
                      min={SEEDANCE_MIN_FRAMES}
                      max={SEEDANCE_MAX_FRAMES}
                      step={4}
                      value={effectiveFrames}
                      disabled={isBusy}
                      onChange={(e) => setFrames(Number(e.target.value))}
                      className="w-40 accent-cyan-500"
                    />
                  )}
                </div>
              </Control>

              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={MIN_SEED}
                    max={MAX_SEED}
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    placeholder="seed"
                    disabled={isBusy}
                    className="w-28 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setSeed(String(Math.floor(Math.random() * 2 ** 32)))
                    }
                    disabled={isBusy}
                    className="p-1.5 text-blue-400 hover:bg-blue-500/10 rounded"
                  >
                    <Dices className="w-4 h-4" />
                  </button>
                </div>
                <Toggle
                  label="Watermark"
                  hint=""
                  checked={watermark}
                  disabled={isBusy}
                  onChange={setWatermark}
                />
                {entry.extras.generateAudio && (
                  <Toggle
                    label="Audio"
                    hint=""
                    checked={generateAudio}
                    disabled={isBusy}
                    onChange={setGenerateAudio}
                  />
                )}
                {entry.extras.cameraFixed && (
                  <Toggle
                    label="Fixed camera"
                    hint=""
                    checked={cameraFixed}
                    disabled={isBusy}
                    onChange={setCameraFixed}
                  />
                )}
                {entry.extras.serviceTier && (
                  <Toggle
                    label="Flex tier"
                    hint="cheaper, slower"
                    checked={flexTier}
                    disabled={isBusy}
                    onChange={setFlexTier}
                  />
                )}
                {entry.extras.draft && (
                  <Toggle
                    label="Draft"
                    hint="1.5-pro"
                    checked={draft}
                    disabled={isBusy}
                    onChange={setDraft}
                  />
                )}
                {entry.extras.priority && (
                  <label className="flex items-center gap-2 text-sm text-gray-300">
                    Priority
                    <input
                      type="number"
                      min={0}
                      max={9}
                      value={priority}
                      disabled={isBusy}
                      onChange={(e) => setPriority(Number(e.target.value))}
                      className="w-14 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-white"
                    />
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="w-full px-6 py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {isBusy ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Send className="w-5 h-5" />
              {isContinuing
                ? continueAction === 'extend'
                  ? `Extend clip #${continueFromIndex}`
                  : `Remix clip #${continueFromIndex}`
                : 'Generate'}
            </>
          )}
        </button>

        {billing && (
          <p className="text-xs text-gray-500 text-center">
            Last bill: {billing.unitsBilled ?? billing.totalTokens} tokens
          </p>
        )}
      </div>
    </div>
  )
}

function Control({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-gray-300">{label}</span>
        {hint && <span className="text-xs text-gray-500">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function ChoiceButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1 text-sm rounded-md transition-colors disabled:opacity-50 ${
        selected
          ? 'bg-cyan-600 text-white'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
      }`}
    >
      {children}
    </button>
  )
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label
      title={hint}
      className={`flex items-center gap-2 text-sm ${
        disabled ? 'opacity-50' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-cyan-500"
      />
      <span className="text-gray-300">{label}</span>
    </label>
  )
}

function FramePicker({
  label,
  media,
  disabled,
  onPick,
  onClear,
}: {
  label: string
  media: AttachedMedia | null
  disabled: boolean
  onPick: () => void
  onClear: () => void
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-2">
        {label}
      </label>
      {media ? (
        <div className="relative">
          <img
            src={media.dataUrl}
            alt={label}
            className="w-full max-h-40 object-contain rounded-lg border border-gray-700"
          />
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="absolute top-2 right-2 p-1 bg-gray-900/90 rounded-full text-white border border-gray-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPick}
          disabled={disabled}
          className="w-full h-28 flex flex-col items-center justify-center border-2 border-dashed border-gray-600 hover:border-gray-500 rounded-lg text-gray-500 disabled:opacity-50"
        >
          <Upload className="w-5 h-5" />
          <span className="text-xs mt-1">Upload image</span>
        </button>
      )}
    </div>
  )
}
