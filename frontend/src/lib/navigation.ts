import { useEffect, useState } from 'react'

// Cabinet sections live in the URL hash so reload and the back button keep the place.
export const PAGES = ['overview', 'servers', 'config', 'logs', 'backups', 'cores', 'updates', 'settings', 'users'] as const
export type Page = (typeof PAGES)[number]

function readPage(): Page {
  const value = window.location.hash.replace(/^#\/?/, '')
  return (PAGES as readonly string[]).includes(value) ? (value as Page) : 'overview'
}

export function navigate(page: Page) {
  if (readPage() !== page) window.location.hash = `/${page}`
}

export function usePage(): Page {
  const [page, setPage] = useState<Page>(readPage)
  useEffect(() => {
    const sync = () => setPage(readPage())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  return page
}
