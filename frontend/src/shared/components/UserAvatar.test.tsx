import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserAvatar } from './UserAvatar';
import { MemberDisc } from '../ui/member-disc';
import { clearAuthedImageCache } from '../api/authed-image';
import { setAccessToken } from '../api/token-store';

/**
 * The two faces this app draws, held to the same contract.
 *
 * `UserAvatar` and `MemberDisc` diverged: one resolved `avatarUrl`, the other
 * did not accept one at all — which is why Профиль showed a photo while
 * Сегодня, Стена and every chore row showed initials for the same person, and
 * why the app read as "the avatars are broken". Both now go through
 * `useAvatarSource`, so both are checked here against the case that actually
 * occurs in production: a Google URL written by OAuth linking.
 */

const GOOGLE_AVATAR = 'https://lh3.googleusercontent.com/a/ACg8ocI3Qw=s96-c';
const OUR_AVATAR = '/api/users/22222222-2222-4222-8222-222222222222/avatar?v=xyz.webp';

/**
 * Radix `AvatarImage` mounts no `<img>` until a probe `new Image()` reports the
 * bytes arrived — that is how it guarantees the fallback is never replaced by a
 * flash of broken image. jsdom loads nothing, so without this the `<img>` under
 * test would never exist and the assertions would be vacuously unreachable.
 *
 * The probe is made to succeed immediately. `complete` + `naturalWidth` are
 * what Radix reads, and it reads them synchronously right after setting `src`.
 */
class LoadedImage extends EventTarget {
  complete = false;
  naturalWidth = 0;
  referrerPolicy = '';
  crossOrigin: string | null = null;
  private value = '';

  get src(): string {
    return this.value;
  }

  set src(next: string) {
    this.value = next;
    this.complete = true;
    this.naturalWidth = 64;
  }
}

describe('person faces', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAuthedImageCache();
    setAccessToken('secret-access-token');
    fetchSpy = vi.fn(
      () =>
        new Promise<Response>(() => {
          /* never settles */
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('Image', LoadedImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthedImageCache();
    setAccessToken(null);
  });

  describe('UserAvatar', () => {
    it('renders a provider avatar as a plain, uncredentialed image', () => {
      render(
        <UserAvatar user={{ id: 'u1', displayName: 'Оля', avatarUrl: GOOGLE_AVATAR }} size="lg" />,
      );

      const image = screen.getByAltText('Оля');
      expect(image).toHaveAttribute('src', GOOGLE_AVATAR);
      // Google gets to know the family opened the app; not which screen.
      expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
      // A CORS-mode image load would need a header Google has no reason to send.
      expect(image).not.toHaveAttribute('crossorigin');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches our own avatar with the session token instead', () => {
      render(<UserAvatar user={{ id: 'u1', displayName: 'Оля', avatarUrl: OUR_AVATAR }} />);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(OUR_AVATAR);
      expect(init.headers).toEqual({ authorization: 'Bearer secret-access-token' });
    });

    it('falls back to initials with no avatar at all', () => {
      render(<UserAvatar user={{ id: 'u1', displayName: 'Оля Иванова' }} />);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.getByText('ОИ')).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('MemberDisc', () => {
    it('lays a provider photo over the coloured disc', () => {
      const { container } = render(
        <MemberDisc id="u2" displayName="Папа" avatarUrl={GOOGLE_AVATAR} />,
      );

      const photo = container.querySelector('[data-slot="member-disc-photo"]');
      expect(photo).not.toBeNull();
      expect(photo).toHaveAttribute('src', GOOGLE_AVATAR);
      expect(photo).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(fetchSpy).not.toHaveBeenCalled();

      // The initial stays underneath: a 404 on the photo must land on a
      // correct coloured disc, not a broken-image glyph.
      expect(container.textContent).toContain('П');
    });

    it('fetches our own avatar with the session token', () => {
      render(<MemberDisc id="u2" displayName="Папа" avatarUrl={OUR_AVATAR} />);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({ authorization: 'Bearer secret-access-token' });
    });

    it('is still a plain coloured disc when the caller has no avatar', () => {
      const { container } = render(<MemberDisc id="u2" displayName="Папа" />);

      expect(container.querySelector('[data-slot="member-disc-photo"]')).toBeNull();
      expect(container.querySelector('[data-slot="member-disc"]')).toHaveAttribute(
        'data-member-slot',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps a member the same colour whether or not they have a photo', () => {
      const withPhoto = render(
        <MemberDisc id="u3" displayName="Лиза" avatarUrl={GOOGLE_AVATAR} />,
      ).container.querySelector('[data-slot="member-disc"]');
      const without = render(<MemberDisc id="u3" displayName="Лиза" />).container.querySelector(
        '[data-slot="member-disc"]',
      );

      expect(withPhoto?.getAttribute('data-member-slot')).toBe(
        without?.getAttribute('data-member-slot'),
      );
    });
  });
});
