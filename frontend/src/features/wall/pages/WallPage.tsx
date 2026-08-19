import { useState } from 'react';
import { PageHeader } from '@/shared/components';
import { Can } from '@/shared/auth';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { AnnouncementComposer } from '../components/AnnouncementComposer';
import { KudosPanel } from '../components/KudosPanel';
import { PollsPanel } from '../components/PollsPanel';
import { WallFeed } from '../components/WallFeed';
import { WALL_RU } from '../locale';

type WallTab = 'feed' | 'polls' | 'kudos';

/**
 * Стена — the family's timeline, its shared decisions and its thank-yous.
 *
 * This is the section that has to be worth opening when nothing is due. An app
 * made only of obligations reads as a work tracker and the teenagers leave
 * first; recognition and shared decisions are what bring people back
 * voluntarily. It is deliberately **not** a chat — no threads-of-threads, no
 * typing indicators, no presence. The family already has a messenger.
 *
 * Three surfaces, one per tab, because a phone screen cannot hold all three at
 * once without one of them becoming noise:
 *
 *  - **Лента** — pinned announcements, then posts and activity in one stream.
 *  - **Опросы** — shared decisions, kept off the timeline so a poll stays
 *    findable while it is open.
 *  - **Спасибо** — kudos totals, listed alphabetically and never ranked.
 *
 * The page adds no chrome of its own: `AppShell` owns the app bar, the
 * navigation and the safe-area padding.
 */
export default function WallPage() {
  const [tab, setTab] = useState<WallTab>('feed');

  return (
    /* Left-aligned, not `mx-auto`: centring this one page inside the shell put
       its title at x=505 while every other section starts at x=330, so switching
       to Стена slid the page sideways. The measure itself is right — a feed is
       a column of prose — it just must not re-centre. */
    <div className="w-full max-w-2xl min-w-0">
      <PageHeader
        title={WALL_RU.title}
        description={WALL_RU.description}
        actions={
          tab === 'feed' ? (
            <Can perm="post:create">
              <AnnouncementComposer />
            </Can>
          ) : null
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as WallTab);
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="feed" className="min-h-11">
            {WALL_RU.tabs.feed}
          </TabsTrigger>
          <TabsTrigger value="polls" className="min-h-11">
            {WALL_RU.tabs.polls}
          </TabsTrigger>
          <TabsTrigger value="kudos" className="min-h-11">
            {WALL_RU.tabs.kudos}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="feed" className="pt-4 pb-safe">
          <WallFeed />
        </TabsContent>
        <TabsContent value="polls" className="pt-4 pb-safe">
          <PollsPanel />
        </TabsContent>
        <TabsContent value="kudos" className="pt-4 pb-safe">
          <KudosPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
