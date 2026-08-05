import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Iteration lives in Studio now (prompt → clip → continue), Omni-style.
 * Keep this path as a redirect so old bookmarks still land somewhere useful.
 */
export const Route = createFileRoute('/seedance-chat')({
  beforeLoad: () => {
    throw redirect({ to: '/' })
  },
})