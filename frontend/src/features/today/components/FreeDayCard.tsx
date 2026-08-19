import { Card } from '@/shared/ui/card';
import { TODAY_RU } from '../locale';

/**
 * The «Сегодня свободно 🎉» state.
 *
 * A blank box would read as a failure — "did it not load?" — on the one screen
 * that must never look broken. So the empty day gets its own small celebration:
 * warm surface, a sentence that gives the day back to the reader, and no call
 * to action nudging them to invent work.
 */
export function FreeDayCard() {
  return (
    <Card className="items-center gap-2 border-dashed bg-accent/40 py-10 text-center">
      <p className="px-6 text-lg font-semibold text-foreground">{TODAY_RU.emptyTitle}</p>
      <p className="max-w-sm px-6 text-sm text-balance text-muted-foreground">
        {TODAY_RU.emptyDescription}
      </p>
    </Card>
  );
}
