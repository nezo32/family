import { cn } from "@/shared/lib/utils"

/**
 * Loading placeholder.
 *
 * `bg-muted`, not stock shadcn's `bg-accent`: in this theme `--accent` is the
 * muted sage used for positive/"good news" surfaces, so a screen full of
 * skeletons read as a screen full of successful content. The placeholder has to
 * be the most neutral surface we have.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
