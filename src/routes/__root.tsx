import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { FaDiscord } from 'react-icons/fa'
import { Menu } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { DISCORD_LINK } from '@/lib/shared'

const NAV_LINKS = [
  { to: '/' as const, label: 'Text' },
  { to: '/markdown' as const, label: 'Markdown' },
  { to: '/subtitle' as const, label: 'Subtitle' },
  { to: '/epub' as const, label: 'EPUB' },
]

const navLinkClass =
  'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground [&.active]:font-medium [&.active]:text-foreground'

export const Route = createRootRoute({
  component: () => (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between border-b px-3 py-4 md:px-6">
        <div className="flex items-center gap-3 md:gap-4">
          <div className="flex items-center gap-2">
            <img src="/icon-128.png" alt="Imp Translate" className="size-6" />
            <h1 className="hidden text-lg font-semibold md:block">Imp Translate</h1>
          </div>
          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((link) => (
              <Link key={link.to} to={link.to} className={navLinkClass}>
                {link.label}
              </Link>
            ))}
          </nav>
          {/* Mobile nav */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex cursor-pointer items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground md:hidden"
            >
              <Menu className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={8} className="w-auto">
              {NAV_LINKS.map((link) => (
                <DropdownMenuItem key={link.to} render={<Link to={link.to} />}>
                  {link.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
