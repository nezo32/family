import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Download, Share2, X } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/shared/ui/sheet';
import { cn } from '@/shared/lib/utils';
import { AUTH_RU } from '../locale';
import { AddToHomeGlyph, IOSShareGlyph } from './BrandMarks';
import {
  detectInstallPlatform,
  dismissInstallPrompt,
  onDeferredInstallPromptChange,
  promptInstall,
  shouldOfferInstall,
  type InstallPlatform,
} from './install';

/**
 * The install card + instruction sheet.
 *
 * Mount it inside the authenticated shell. It decides for itself whether to
 * render anything at all (see `install.ts`): nothing on first load, nothing when
 * the app is already installed, nothing until the user has actually done
 * something, and nothing for two weeks after a dismissal.
 *
 * On iOS there is no install API to call — the entire mechanism is a person
 * finding the share button — so the sheet draws the real glyph and puts the
 * steps in the order that device shows them (iPhone: bottom toolbar; iPad: top).
 */
export function InstallPrompt({
  force = false,
  className,
}: {
  /** Skip the engagement/dismissal gates. For a deliberate "install" entry point. */
  force?: boolean;
  className?: string;
}) {
  const [platform, setPlatform] = useState<InstallPlatform>(() => detectInstallPlatform());
  const [visible, setVisible] = useState(() => force || shouldOfferInstall());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Chromium may hand us `beforeinstallprompt` after this mounted; that turns a
  // generic hint into a real one-tap install.
  useEffect(
    () =>
      onDeferredInstallPromptChange(() => {
        setPlatform(detectInstallPlatform());
        setVisible(force || shouldOfferInstall());
      }),
    [force],
  );

  const hide = useCallback(() => {
    setSheetOpen(false);
    setVisible(false);
  }, []);

  const handleLater = useCallback(() => {
    dismissInstallPrompt();
    hide();
  }, [hide]);

  const handleInstall = useCallback(async () => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') {
      hide();
      return;
    }
    if (outcome === 'unavailable') {
      setSheetOpen(true);
      return;
    }
    // Declined the OS dialog: respect it like our own "Позже".
    handleLater();
  }, [handleLater, hide]);

  const handleCopyLink = useCallback(() => {
    void navigator.clipboard?.writeText(window.location.href).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  }, []);

  if (!visible || platform === 'standalone') return null;

  const canInstallDirectly = platform === 'chromium';

  return (
    <>
      <div
        className={cn(
          'relative rounded-xl border bg-card p-4 text-card-foreground shadow-sm',
          className,
        )}
        data-testid="install-card"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // 44px. This card only became reachable once `recordEngagement()` was
          // actually wired up, so its targets had never been measured.
          className="absolute top-1 right-1 size-11 text-muted-foreground"
          onClick={handleLater}
          aria-label={AUTH_RU.install.dismissLabel}
        >
          <X aria-hidden />
        </Button>

        <div className="flex items-start gap-3 pr-8">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {platform === 'chromium' ? <Download aria-hidden /> : <Share2 aria-hidden />}
          </span>
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-balance">{AUTH_RU.install.cardTitle}</p>
            <p className="text-sm text-muted-foreground text-pretty">{AUTH_RU.install.cardText}</p>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          {canInstallDirectly ? (
            <Button type="button" className="h-11 flex-1" onClick={() => void handleInstall()}>
              {AUTH_RU.install.cardInstall}
            </Button>
          ) : (
            <Button
              type="button"
              className="h-11 flex-1"
              onClick={() => {
                setSheetOpen(true);
              }}
            >
              {AUTH_RU.install.cardAction}
            </Button>
          )}
          <Button type="button" variant="ghost" className="h-11" onClick={handleLater}>
            {AUTH_RU.install.cardLater}
          </Button>
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto pb-safe">
          <SheetHeader>
            <SheetTitle>{sheetTitleFor(platform)}</SheetTitle>
            <SheetDescription>
              {platform === 'ios-other-browser'
                ? AUTH_RU.install.safariOnlyText
                : AUTH_RU.install.sheetDescription}
            </SheetDescription>
          </SheetHeader>

          <div className="px-4">
            {platform === 'ios-other-browser' ? (
              <div className="space-y-3">
                <p className="rounded-lg bg-muted px-3 py-2 font-mono text-sm break-all">
                  {typeof window === 'undefined' ? '' : window.location.href}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full"
                  onClick={handleCopyLink}
                >
                  {copied ? AUTH_RU.install.copiedLink : AUTH_RU.install.copyLink}
                </Button>
              </div>
            ) : platform === 'chromium' || platform === 'other' ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{AUTH_RU.install.desktopText}</p>
                {platform === 'chromium' ? (
                  <Button
                    type="button"
                    className="h-11 w-full"
                    onClick={() => void handleInstall()}
                  >
                    {AUTH_RU.install.cardInstall}
                  </Button>
                ) : null}
              </div>
            ) : (
              <ol className="space-y-3">
                <Step index={1} glyph={<IOSShareGlyph className="size-4" />}>
                  {isIPadPlatform()
                    ? AUTH_RU.install.stepShareIpad
                    : AUTH_RU.install.stepShareIphone}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {AUTH_RU.install.shareGlyphHint}
                  </span>
                </Step>
                <Step index={2} glyph={<AddToHomeGlyph className="size-4" />}>
                  {AUTH_RU.install.stepAddToHome}
                </Step>
                <Step index={3}>{AUTH_RU.install.stepConfirm}</Step>
                <Step index={4}>{AUTH_RU.install.stepDone}</Step>
              </ol>
            )}
          </div>

          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full"
              onClick={() => {
                setSheetOpen(false);
              }}
            >
              {AUTH_RU.install.close}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Step({
  index,
  glyph,
  children,
}: {
  index: number;
  glyph?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
        {index}
      </span>
      <span className="min-w-0 text-sm">
        {glyph ? (
          <span className="mr-1.5 inline-flex translate-y-0.5 items-center text-primary">
            {glyph}
          </span>
        ) : null}
        {children}
      </span>
    </li>
  );
}

/**
 * iPad puts the share button in the *top* toolbar, iPhone at the bottom. Getting
 * this backwards sends the user hunting across the wrong edge of the screen,
 * which is the single most common reason these instructions fail.
 */
function isIPadPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function sheetTitleFor(platform: InstallPlatform): string {
  if (platform === 'ios-other-browser') return AUTH_RU.install.safariOnlyTitle;
  if (platform === 'ios-safari') {
    return isIPadPlatform() ? AUTH_RU.install.sheetTitleIpad : AUTH_RU.install.sheetTitle;
  }
  return AUTH_RU.install.sheetTitleDesktop;
}

export default InstallPrompt;
