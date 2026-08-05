import { createFileRoute } from '@tanstack/react-router'
import {
  chat,
  chatParamsFromRequestBody,
  maxIterations,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { openaiText } from '@tanstack/ai-openai'
import { byteplusText } from '@tanstack/ai-byteplus'
import type { AnyTextAdapter } from '@tanstack/ai'
import { SEEDANCE_CHAT_SYSTEM_PROMPT } from '@/lib/seedance-chat-tools'
import {
  extendClip,
  generateClip,
  listIterationModes,
  remixClip,
} from '@/lib/seedance-chat-tools.server'

/**
 * Chat agent that drives Seedance generate / remix / extend tools.
 *
 * Prefers OpenAI for tool-calling quality when `OPENAI_API_KEY` is set;
 * otherwise falls back to BytePlus Seed chat on the same `ARK_API_KEY` used
 * for video (handy for an all-BytePlus setup).
 */
function resolveChatAdapter(): AnyTextAdapter {
  if (process.env.OPENAI_API_KEY) {
    return openaiText('gpt-5.5')
  }
  if (process.env.ARK_API_KEY || process.env.BYTEPLUS_API_KEY) {
    // Structured-output rejector models are fine for tools; this Seed id is
    // in the structured-output support list and is a solid default.
    return byteplusText('dola-seed-2-1-turbo-260628')
  }
  throw new Error(
    'Seedance Chat needs OPENAI_API_KEY (preferred) or ARK_API_KEY / BYTEPLUS_API_KEY for the chat model. Video generation still requires ARK_API_KEY.',
  )
}

export const Route = createFileRoute('/api/seedance-chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.signal.aborted) {
          return new Response(null, { status: 499 })
        }

        const abortController = new AbortController()
        const onAbort = () => abortController.abort()
        request.signal.addEventListener('abort', onAbort, { once: true })
        if (request.signal.aborted) {
          onAbort()
        }

        let params
        try {
          params = await chatParamsFromRequestBody(await request.json())
        } catch (error) {
          return new Response(
            error instanceof Error ? error.message : 'Bad request',
            { status: 400 },
          )
        }

        try {
          const adapter = resolveChatAdapter()
          // Seedance jobs can sit in the tool loop for many minutes. Cap agent
          // tool rounds (not wall-clock) so a runaway plan still stops.
          const stream = chat({
            adapter,
            messages: params.messages,
            systemPrompts: [SEEDANCE_CHAT_SYSTEM_PROMPT],
            tools: [
              generateClip,
              remixClip,
              extendClip,
              listIterationModes,
            ],
            agentLoopStrategy: maxIterations(8),
            stream: true,
            threadId: params.threadId,
            runId: params.runId,
            abortController,
          })

          return toServerSentEventsResponse(stream, {
            abortController,
          })
        } catch (error) {
          return new Response(
            error instanceof Error ? error.message : 'Chat failed',
            { status: 500 },
          )
        } finally {
          request.signal.removeEventListener('abort', onAbort)
        }
      },
    },
  },
})
