import { createFileRoute, redirect } from '@tanstack/react-router'

// EPUB translation now lives on the unified /files route; keep this path
// alive so old links/bookmarks still work.
export const Route = createFileRoute('/epub')({
  beforeLoad: () => {
    throw redirect({ to: '/files' })
  },
})
