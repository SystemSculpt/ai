/**
 * Client-safe generation scope ids for Seedance Studio / Chat.
 * Kept separate from `generation-persistence.ts` so browser bundles never
 * initialize the in-process store.
 */

/** Stable scope for the form-based Seedance Studio (one "slot", many runs). */
export const SEEDANCE_STUDIO_THREAD_ID = 'seedance-studio'

/** Scope for one chat-produced clip. Each clip is its own restore slot. */
export function seedanceChatThreadId(clipId: string): string {
  return `seedance-chat:${clipId}`
}
