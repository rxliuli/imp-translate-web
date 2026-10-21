import { createFileRoute, redirect } from '@tanstack/react-router'

// Subtitle translation now lives on the unified /files route; keep this path
// alive so old links/bookmarks still work.
export const Route = createFileRoute('/subtitle')({
  beforeLoad: () => {
    throw redirect({ to: '/files' })
  },
})
