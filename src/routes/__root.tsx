import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { FaDiscord } from 'react-icons/fa'
import { buttonVariants } from '@/components/ui/button'
import { DISCORD_LINK } from '@/lib/shared'

export const Route = createRootRoute({
  component: () => (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between border-b px-3 py-4 md:px-6">
        <div className="flex items-center gap-3 md:gap-4">
          <div className="flex items-center gap-2">
            <img src="/icon-128.png" alt="Imp Translate" className="size-6" />
            <h1 className="hidden text-lg font-semibold md:block">Imp Translate</h1>
          </div>
          <nav className="flex items-center gap-1">
            <Link
              to="/"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground [&.active]:font-medium [&.active]:text-foreground"
            >
              Text
            </Link>
            <Link
              to="/markdown"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground [&.active]:font-medium [&.active]:text-foreground"
            >
              Markdown
            </Link>
            <Link
              to="/subtitle"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground [&.active]:font-medium [&.active]:text-foreground"
            >
              Subtitle
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={DISCORD_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'secondary' })}
          >
            <FaDiscord className="size-4 text-[#5865F2]" />
            <span className="hidden md:inline">Discord</span>
          </a>
        </div>
      </header>
      <Outlet />
    </div>
  ),
})
