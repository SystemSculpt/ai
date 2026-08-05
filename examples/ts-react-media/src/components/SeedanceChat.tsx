import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Clapperboard,
  Download,
  Film,
  GitBranch,
  Loader2,
  Send,
  Sparkles,
} from 'lucide-react'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import type { SeedanceClipOutput } from '@/lib/seedance-chat-tools'
import {
  extendClipToolDef,
  generateClipToolDef,
  listIterationModesToolDef,
  remixClipToolDef,
} from '@/lib/seedance-chat-tools'
import AutoGrowTextarea from '@/components/AutoGrowTextarea'

const SUGGESTIONS = [
  'Generate a 5s clip of a red vintage scooter driving through a rainy Tokyo alley at night',
  'Remix the latest clip with golden hour lighting and warmer tones',
  'Extend the latest shot — the scooter turns the corner and stops under a neon sign',
  'How do the iteration modes work?',
] as const

function isClipOutput(value: unknown): value is SeedanceClipOutput {
  if (typeof value !== 'object' || value === null) return false
  if (!('videoUrl' in value) || !('clipId' in value) || !('mode' in value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.videoUrl === 'string' &&
    typeof record.clipId === 'string' &&
    (record.mode === 'generate' ||
      record.mode === 'remix' ||
      record.mode === 'extend')
  )
}

function modeLabel(mode: SeedanceClipOutput['mode']): string {
  switch (mode) {
    case 'generate':
      return 'Generate'
    case 'remix':
      return 'Remix'
    case 'extend':
      return 'Extend'
  }
}

function modeColor(mode: SeedanceClipOutput['mode']): string {
  switch (mode) {
    case 'generate':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    case 'remix':
      return 'bg-violet-500/15 text-violet-300 border-violet-500/30'
    case 'extend':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30'
  }
}

/**
 * Chat-driven Seedance iteration: talk to an agent that generates, remixes
 * (reference video), and extends (last-frame chain) clips. Tool results feed
 * a version stack on the right so you can scrub history while conversing.
 */
export default function SeedanceChat() {
  const [input, setInput] = useState('')
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)

  const { messages, sendMessage, isLoading, error, clear } = useChat({
    threadId: 'seedance-chat',
    connection: fetchServerSentEvents('/api/seedance-chat'),
    // Client-side defs only for typed tool-call parts; execution is server-side.
    tools: [
      generateClipToolDef,
      remixClipToolDef,
      extendClipToolDef,
      listIterationModesToolDef,
    ],
  })

  const clips = useMemo(() => {
    const found: Array<SeedanceClipOutput> = []
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== 'tool-call') continue
        if (
          part.name !== 'generate_clip' &&
          part.name !== 'remix_clip' &&
          part.name !== 'extend_clip'
        ) {
          continue
        }
        if (part.state === 'complete' && isClipOutput(part.output)) {
          // Prefer the latest occurrence of a clipId if the model ever repeats.
          const existing = found.findIndex(
            (c) => c.clipId === part.output!.clipId,
          )
          if (existing >= 0) found[existing] = part.output
          else found.push(part.output)
        }
      }
    }
    return found
  }, [messages])

  const selectedClip =
    clips.find((c) => c.clipId === selectedClipId) ?? clips[clips.length - 1]

  // Surface in-flight tool calls for a status strip while Seedance is working.
  const pendingToolNames = messages
    .flatMap((m) => m.parts)
    .flatMap((part) => {
      if (part.type !== 'tool-call') return []
      if (
        part.name !== 'generate_clip' &&
        part.name !== 'remix_clip' &&
        part.name !== 'extend_clip'
      ) {
        return []
      }
      if (part.state === 'complete' || part.state === 'error') return []
      return [part.name]
    })

  const handleSend = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isLoading) return
    void sendMessage(trimmed)
    setInput('')
  }

  const handleIterate = (mode: 'remix' | 'extend') => {
    if (!selectedClip || isLoading) return
    if (mode === 'remix') {
      setInput(
        `Remix ${selectedClip.clipId}: same subject and motion, but `,
      )
      return
    }
    if (!selectedClip.lastFrameUrl) {
      setInput(
        `Extend ${selectedClip.clipId} if a last frame is available — continue the action with `,
      )
      return
    }
    setInput(`Extend ${selectedClip.clipId}: continue the shot with `)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 min-h-[calc(100vh-8rem)]">
      {/* Chat column */}
      <div className="flex flex-col rounded-2xl border border-gray-700/80 bg-gray-950/60 overflow-hidden min-h-[32rem]">
        <div className="px-5 py-4 border-b border-gray-800 flex items-start gap-3">
          <div className="mt-0.5 p-2 rounded-lg bg-orange-500/10 text-orange-300">
            <Clapperboard className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-white">
              Seedance Chat Director
            </h2>
            <p className="text-sm text-gray-400 mt-0.5">
              Describe a shot, then iterate with natural language — remix via
              reference video, or extend from the last frame. Needs{' '}
              <code className="text-gray-300">ARK_API_KEY</code> for Seedance
              and preferably <code className="text-gray-300">OPENAI_API_KEY</code>{' '}
              for the chat agent.
            </p>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => clear()}
              className="text-xs text-gray-400 hover:text-white shrink-0"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                Try a starter, or type your own brief. Generations take a few
                minutes — the agent will keep the connection open while Ark
                works.
              </p>
              <div className="grid gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSend(suggestion)}
                    disabled={isLoading}
                    className="text-left text-sm px-3 py-2.5 rounded-xl border border-gray-700 bg-gray-900/80 text-gray-200 hover:border-orange-500/40 hover:bg-gray-900 transition-colors disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5 inline mr-2 text-orange-400" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  message.role === 'user'
                    ? 'bg-orange-500 text-gray-950'
                    : 'bg-gray-800/90 text-gray-100 border border-gray-700/60'
                }`}
              >
                {message.parts.map((part, index) => {
                  if (part.type === 'text' && part.content) {
                    return (
                      <p key={index} className="whitespace-pre-wrap">
                        {part.content}
                      </p>
                    )
                  }
                  if (part.type === 'tool-call') {
                    const done = part.state === 'complete'
                    const failed = part.state === 'error'
                    const clip =
                      done && isClipOutput(part.output) ? part.output : null
                    return (
                      <div
                        key={part.id}
                        className="my-2 rounded-xl border border-gray-600/50 bg-gray-950/50 p-3"
                      >
                        <div className="flex items-center gap-2 text-xs font-medium text-gray-300">
                          {done ? (
                            <Film className="w-3.5 h-3.5 text-emerald-400" />
                          ) : failed ? (
                            <span className="text-red-400">✕</span>
                          ) : (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-400" />
                          )}
                          <span className="font-mono">{part.name}</span>
                          {!done && !failed && (
                            <span className="text-gray-500">
                              running (Seedance can take several minutes)…
                            </span>
                          )}
                        </div>
                        {clip && (
                          <div className="mt-2 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${modeColor(clip.mode)}`}
                              >
                                {modeLabel(clip.mode)}
                              </span>
                              <span className="text-xs font-mono text-gray-400">
                                {clip.clipId}
                              </span>
                            </div>
                            <video
                              src={clip.videoUrl}
                              controls
                              className="w-full rounded-lg bg-black max-h-56"
                            />
                            <p className="text-xs text-gray-400 line-clamp-2">
                              {clip.prompt}
                            </p>
                          </div>
                        )}
                        {failed && (
                          <p className="mt-1 text-xs text-red-400">
                            Tool failed — check server logs / ARK_API_KEY
                          </p>
                        )}
                      </div>
                    )
                  }
                  if (part.type === 'thinking' && part.content) {
                    return (
                      <p
                        key={index}
                        className="text-xs text-gray-500 italic mb-2 whitespace-pre-wrap"
                      >
                        {part.content}
                      </p>
                    )
                  }
                  return null
                })}
              </div>
            </div>
          ))}

          {pendingToolNames.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-orange-300/90 px-1">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting on Seedance ({pendingToolNames.join(', ')})…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error.message}
            </div>
          )}
        </div>

        <div className="border-t border-gray-800 p-4 space-y-2">
          {selectedClip && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleIterate('remix')}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-violet-500/40 text-violet-200 hover:bg-violet-500/10 disabled:opacity-50"
              >
                <GitBranch className="w-3.5 h-3.5" />
                Remix selected
              </button>
              <button
                type="button"
                onClick={() => handleIterate('extend')}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-sky-500/40 text-sky-200 hover:bg-sky-500/10 disabled:opacity-50"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                Extend selected
              </button>
            </div>
          )}
          <form
            className="flex gap-2 items-end"
            onSubmit={(event) => {
              event.preventDefault()
              handleSend(input)
            }}
          >
            <AutoGrowTextarea
              value={input}
              onChange={setInput}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  handleSend(input)
                }
              }}
              minRows={2}
              maxRows={14}
              placeholder="Describe a shot, or how to iterate on the latest clip…"
              className="flex-1 rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm leading-relaxed text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-orange-500/50"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="shrink-0 inline-flex items-center justify-center rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 disabled:cursor-not-allowed text-gray-950 p-3"
              aria-label="Send"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </form>
        </div>
      </div>

      {/* Version stack */}
      <aside className="rounded-2xl border border-gray-700/80 bg-gray-950/60 overflow-hidden flex flex-col min-h-[20rem]">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white">Version stack</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {clips.length === 0
              ? 'Clips from tool results appear here'
              : `${clips.length} clip${clips.length === 1 ? '' : 's'} this session`}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {clips.length === 0 && (
            <div className="text-center text-sm text-gray-500 py-10 px-4">
              Generate a clip in chat to start the stack. Remix and extend
              branch from the selected version.
            </div>
          )}
          {[...clips].reverse().map((clip, reverseIndex) => {
            const version = clips.length - reverseIndex
            const isSelected = selectedClip?.clipId === clip.clipId
            return (
              <button
                key={clip.clipId}
                type="button"
                onClick={() => setSelectedClipId(clip.clipId)}
                className={`w-full text-left rounded-xl border p-2.5 transition-colors ${
                  isSelected
                    ? 'border-orange-500/50 bg-orange-500/5'
                    : 'border-gray-700 bg-gray-900/50 hover:border-gray-600'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-300">
                    v{version}{' '}
                    <span className="font-mono text-gray-500">
                      {clip.clipId}
                    </span>
                  </span>
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${modeColor(clip.mode)}`}
                  >
                    {modeLabel(clip.mode)}
                  </span>
                </div>
                <video
                  src={clip.videoUrl}
                  className="w-full rounded-lg bg-black aspect-video object-cover"
                  muted
                  playsInline
                  onMouseEnter={(e) => {
                    void e.currentTarget.play().catch(() => {})
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.pause()
                    e.currentTarget.currentTime = 0
                  }}
                />
                <p className="mt-2 text-xs text-gray-400 line-clamp-2">
                  {clip.prompt}
                </p>
                {clip.parentClipId && (
                  <p className="mt-1 text-[10px] text-gray-500 font-mono">
                    from {clip.parentClipId}
                  </p>
                )}
                <a
                  href={clip.videoUrl}
                  download={`${clip.clipId}.mp4`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-orange-300 hover:text-orange-200"
                >
                  <Download className="w-3 h-3" />
                  {clip.videoUrl.startsWith('/api/artifacts')
                    ? 'Open durable clip'
                    : 'Open / save (provider URL expires ~24h)'}
                </a>
              </button>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
