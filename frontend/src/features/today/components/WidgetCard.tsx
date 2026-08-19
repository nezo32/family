import type { ComponentType, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@/shared/ui/card';
import { cn } from '@/shared/lib/utils';

/**
 * The one card shell every widget on «Сегодня» uses.
 *
 * Having a single shell is what makes the screen scan as one thing rather than
 * seven plugins: identical title row, identical footer link, identical
 * spacing. Widgets supply content, never chrome.
 *
 * `tone="urgent"` warms the border and tints the icon. It never turns the card
 * red: overdue chores are a nudge, and a home screen that shouts at a parent
 * every morning gets closed for good.
 */
export function WidgetCard(props: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  tone?: 'default' | 'urgent' | 'quiet';
  /** Small counter next to the title, already pluralised. */
  meta?: ReactNode;
  /** Footer deep-link into the owning section. */
  linkTo?: string;
  linkLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const tone = props.tone ?? 'default';
  const Icon = props.icon;

  return (
    <Card
      className={cn(
        'gap-0 overflow-hidden py-0',
        tone === 'urgent' && 'border-destructive/35 bg-destructive/[0.04]',
        tone === 'quiet' && 'bg-card/60',
        props.className,
      )}
    >
      <div className="flex items-center gap-3 px-4 pt-4 pb-2 sm:px-5">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            tone === 'urgent'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-secondary text-muted-foreground',
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">
          {props.title}
        </h2>
        {props.meta ? (
          <span className="shrink-0 text-xs text-muted-foreground">{props.meta}</span>
        ) : null}
      </div>

      <div className="px-4 pb-4 sm:px-5">{props.children}</div>

      {props.linkTo && props.linkLabel ? (
        <Link
          to={props.linkTo}
          // 44 px minimum target: this is read and tapped at arm's length.
          className="flex min-h-11 items-center justify-between gap-2 border-t border-border/70 px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:px-5"
        >
          <span className="truncate">{props.linkLabel}</span>
          <ChevronRight className="size-4 shrink-0" aria-hidden />
        </Link>
      ) : null}
    </Card>
  );
}
