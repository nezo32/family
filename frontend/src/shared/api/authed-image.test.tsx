import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAuthedImageCache, isApiImagePath, useAvatarSource } from './authed-image';
import { setAccessToken } from './token-store';

/**
 * The rule this file exists to hold: **the session's bearer token goes to our
 * own origin and nowhere else.**
 *
 * `avatarUrl` is not our data. `PATCH /api/me` takes any absolute `https://`
 * URL up to 2048 characters and writes it to the row; OAuth linking writes
 * `https://lh3.googleusercontent.com/…` there, and in production that is what
 * *every* account has. So the value that decides how an avatar is loaded is
 * chosen by whoever last edited the profile — which makes "which URLs get the
 * `Authorization` header" a security question rather than a loading strategy.
 *
 * The visual half of the bug is tested alongside it, because the two failure
 * modes look identical on screen: an avatar that renders as initials tells you
 * nothing about whether a token just went to Google.
 */

const OUR_AVATAR = '/api/users/11111111-1111-4111-8111-111111111111/avatar?v=abc.webp';
const GOOGLE_AVATAR = 'https://lh3.googleusercontent.com/a/ACg8ocKNGx=s96-c';

function Probe(props: { url: string | null | undefined }) {
  const { src, external } = useAvatarSource(props.url);
  return (
    <div>
      <span data-testid="src">{src ?? ''}</span>
      <span data-testid="external">{String(external)}</span>
    </div>
  );
}

function fetchedUrls(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe('authed-image', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAuthedImageCache();
    setAccessToken('secret-access-token');
    fetchSpy = vi.fn(
      () =>
        new Promise<Response>(() => {
          /* never settles: the assertions are about the call, not the bytes */
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthedImageCache();
    setAccessToken(null);
  });

  describe('isApiImagePath', () => {
    it('accepts our own avatar route', () => {
      expect(isApiImagePath(OUR_AVATAR)).toBe(true);
      expect(isApiImagePath(`${window.location.origin}${OUR_AVATAR}`)).toBe(true);
    });

    it('rejects a provider URL', () => {
      expect(isApiImagePath(GOOGLE_AVATAR)).toBe(false);
      expect(isApiImagePath('https://t.me/i/userpic/320/abc.jpg')).toBe(false);
    });

    /**
     * The whole reason this is decided by `URL` and not by `startsWith`. Every
     * one of these is a string a family member can put in their own profile,
     * and every one of them defeats some plausible prefix check.
     */
    it.each([
      ['a provider path that happens to look like ours', 'https://lh3.googleusercontent.com/api/x'],
      ['our origin as a hostname prefix', 'https://localhost.evil.example/api/x'],
      ['our origin in the userinfo', 'https://localhost:3000@evil.example/api/x'],
      ['a protocol-relative URL', '//evil.example/api/x'],
      ['a scheme that cannot carry a header usefully', 'javascript:fetch("/api/me")'],
      ['not a URL at all', 'not a url'],
    ])('rejects %s', (_label, url) => {
      expect(isApiImagePath(url)).toBe(false);
    });
  });

  it('renders a provider URL directly, with no credentialed fetch', async () => {
    render(<Probe url={GOOGLE_AVATAR} />);

    // Straight into `<img src>` — no object URL, no round trip.
    expect(screen.getByTestId('src')).toHaveTextContent(GOOGLE_AVATAR);
    expect(screen.getByTestId('external')).toHaveTextContent('true');

    // The assertion that matters: not "no Authorization header on the request
    // to Google", but no request to Google from us at all.
    await waitFor(() => {
      expect(fetchedUrls(fetchSpy)).not.toContain(GOOGLE_AVATAR);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches our own avatar with the bearer token', async () => {
    render(<Probe url={OUR_AVATAR} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OUR_AVATAR);
    expect(init.headers).toEqual({ authorization: 'Bearer secret-access-token' });
    expect(init.credentials).toBe('same-origin');
    expect(screen.getByTestId('external')).toHaveTextContent('false');
  });

  it('never attaches the token to a provider URL, even for a caller that asks it to', async () => {
    // The guard is inside the fetch, not at the call site, so this holds no
    // matter which component is doing the asking.
    render(<Probe url={GOOGLE_AVATAR} />);
    render(<Probe url="https://evil.example/api/users/x/avatar" />);
    render(<Probe url={OUR_AVATAR} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(fetchedUrls(fetchSpy)).toEqual([OUR_AVATAR]);
  });

  it('treats a missing avatar as "show the initials"', () => {
    render(<Probe url={null} />);
    expect(screen.getByTestId('src')).toHaveTextContent('');
    expect(screen.getByTestId('external')).toHaveTextContent('false');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
