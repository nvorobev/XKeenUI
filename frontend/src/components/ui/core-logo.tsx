import { cn } from '@/lib/utils'

export function CoreLogo({ core, className }: { core: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('size-4.75 shrink-0', className)}
    >
      <path d={core === 'mihomo' ? 'M4 19V5l8 8 8-8v14' : 'M5 5l14 14M19 5L5 19'} />
    </svg>
  )
}
