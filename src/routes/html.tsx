import { createFileRoute, redirect } from '@tanstack/react-router'

// HTML translation now lives on the unified /files route; keep this path
// alive so old links/bookmarks still work.
export const Route = createFileRoute('/html')({
  beforeLoad: () => {
    throw redirect({ to: '/files' })
  },
})
