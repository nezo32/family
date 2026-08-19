import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

import { useTheme } from '@/app/theme-provider';

/**
 * Toaster.
 *
 * Deviates from the upstream shadcn component in two ways:
 *  - reads the theme from our own `ThemeProvider` instead of `next-themes`,
 *    which is not a dependency of this package;
 *  - offsets itself above the mobile tab bar and the home indicator, so a toast
 *    never lands under the navigation in the installed PWA.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      position="top-center"
      offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
      mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
