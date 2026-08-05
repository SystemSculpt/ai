import { Link } from '@tanstack/react-router'
import { Clapperboard, MessageSquare } from 'lucide-react'

/**
 * Studio ↔ Chat switcher. Chat was a second top-nav item and easy to miss;
 * putting the modes next to the page title makes both halves of Seedance
 * equally discoverable.
 */
export default function SeedanceModeNav({
  active,
}: {
  active: 'studio' | 'chat'
}) {
  const base =
    'inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors'
  const idle = 'text-gray-400 hover:text-white hover:bg-gray-800'
  const on = 'bg-orange-500/15 text-orange-200 border border-orange-500/30'

  return (
    <div
      role="tablist"
      aria-label="Seedance mode"
      className="inline-flex p-1 rounded-xl bg-gray-800/80 border border-gray-700 gap-0.5"
    >
      <Link
        to="/seedance"
        role="tab"
        aria-selected={active === 'studio'}
        className={`${base} ${active === 'studio' ? on : idle}`}
      >
        <Clapperboard className="w-4 h-4" />
        Studio
      </Link>
      <Link
        to="/seedance-chat"
        role="tab"
        aria-selected={active === 'chat'}
        className={`${base} ${active === 'chat' ? on : idle}`}
      >
        <MessageSquare className="w-4 h-4" />
        Chat
        {active !== 'chat' && (
          <span className="hidden sm:inline text-[10px] uppercase tracking-wide text-orange-300/80 ml-0.5">
            iterate
          </span>
        )}
      </Link>
    </div>
  )
}
