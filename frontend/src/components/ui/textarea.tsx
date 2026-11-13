import * as React from 'react'

import { cn } from '@/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input-background dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 bg-input-background flex field-sizing-content min-h-16 w-full rounded-md border px-2.5 py-2 text-base transition-colors outline-none focus-visible:border-[#60a5fa] focus-visible:shadow-[0_0_0_3px_rgba(59,130,246,0.15)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 md:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
