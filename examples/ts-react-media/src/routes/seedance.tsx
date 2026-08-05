import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Seedance Studio now lives as a tab under Visual Content Generator (`/`),
 * same as Omni. Keep this path so old bookmarks still land on the app.
 */
export const Route = createFileRoute('/seedance')({
  beforeLoad: () => {
    throw redirect({ to: '/' })
  },
})
