import { useState } from 'react';
import { PageHeader } from '@/shared/components';
import { Can } from '@/shared/auth';
import { SideColumn } from '@/app/layout/SideColumn';
import { SectionStack } from '@/shared/ui/section';
import { useTwoColumn } from '@/shared/hooks/use-two-column';
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
 * ## One layout per width, not one layout stretched (§C4)
 *
 * From 1088px there is a side column, so §D7's composition applies directly:
 * the feed takes the main column at its full measure, «Спасибо» and «Опросы»
 * take the side. There are no tabs, because nothing is competing for the same
 * space.
 *
 * Below that there is one column, and the three surfaces go back to being tabs.
 * The obvious alternative — let the side column collapse under the main one, as
 * it does everywhere else — does not work *here* and it is worth saying why:
 * the feed is **cursor-paginated and auto-loading**, so anything rendered below
 * it on a phone is behind an unbounded scroll. Опросы would be reachable in
 * theory and unreachable in practice.
 *
 * This is the one screen in the app that mounts a different tree at the two
 * widths (`useTwoColumn`), and that is deliberate: both `PollsPanel` and
 * `KudosPanel` own a composer with typed state, and rendering two copies with
 * one hidden would give the same half-written question two places to live.
 *
 * The composer is not permanently on screen either way. It is the page's one
 * primary action, hoisted into the app bar from `md` up by `PageHeader` (§D7).
 */
export default function WallPage() {
  const [tab, setTab] = useState<WallTab>('feed');
  const wide = useTwoColumn();

  const composer = (
    <Can perm="post:create">
      <AnnouncementComposer />
    </Can>
  );

  if (wide) {
    return (
      <>
        <PageHeader title={WALL_RU.title} actions={composer} />
        <WallFeed />
        <SideColumn>
          <SectionStack>
            <KudosPanel />
            <PollsPanel />
          </SectionStack>
        </SideColumn>
      </>
    );
  }

  return (
    <>
      <PageHeader title={WALL_RU.title} actions={tab === 'feed' ? composer : null} />

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

        <TabsContent value="feed" className="pt-4">
          <WallFeed />
        </TabsContent>
        <TabsContent value="polls" className="pt-4">
          <PollsPanel />
        </TabsContent>
        <TabsContent value="kudos" className="pt-4">
          <KudosPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}
