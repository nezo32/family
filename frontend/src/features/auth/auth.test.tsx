import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ERROR_MESSAGES_RU } from '@/shared/api/errors-ru';
import { clearAccessToken } from '@/shared/api/token-store';
import { resetRefreshState } from '@/shared/api/refresh';
import LoginPage from './pages/LoginPage';
import { InstallPrompt } from './components/InstallPrompt';
import { enabledOAuthProviders, oauthStartUrl } from './api';
import { AUTH_RU } from './locale';

/**
 * What is worth testing here, and why:
 *
 *  - the login form must surface the **Russian** copy from `errors-ru.ts`, never
 *    the server's English `message` (D7). That is a rule a type check cannot
 *    enforce and a refactor can silently break;
 *  - a provider button must be a top-level navigation, because `window.open` is
 *    the one thing that cannot work in an installed iOS PWA;
 *  - the install sheet must stay away when the app is already installed, and
 *    must tell a non-Safari iOS user to open Safari instead of hunting for a
 *    share sheet that cannot install anything.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderWithProviders(ui: ReactElement, route = '/login'): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Replace `window.location` with a spyable stand-in for the duration of a test. */
function stubLocation(): { assign: ReturnType<typeof vi.fn>; restore: () => void } {
  const original = window.location;
  const assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      ...original,
      href: original.href,
      origin: original.origin,
      pathname: original.pathname,
      search: original.search,
      assign,
      replace: vi.fn(),
      reload: vi.fn(),
    },
  });
  return {
    assign,
    restore: () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

function stubUserAgent(userAgent: string, maxTouchPoints = 5): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: maxTouchPoints,
  });
}

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  clearAccessToken();
  resetRefreshState();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* login form                                                                  */
/* -------------------------------------------------------------------------- */

describe('LoginPage — email + password', () => {
  it('validates before sending anything to the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<LoginPage />);
    await user.click(screen.getByRole('button', { name: AUTH_RU.login.submit }));

    // Messages come from the zod contract in `@family/shared`, in Russian.
    expect(await screen.findByText('Некорректный адрес электронной почты')).toBeInTheDocument();
    expect(screen.getByText('Введите пароль')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the Russian copy for the error code, not the server message', async () => {
    const serverMessage = 'Invalid email or password';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(401, {
            error: { code: 'INVALID_CREDENTIALS', message: serverMessage },
          }),
        ),
      ),
    );
    const user = userEvent.setup();

    renderWithProviders(<LoginPage />);
    await user.type(screen.getByLabelText(AUTH_RU.login.emailLabel), 'anya@example.com');
    await user.type(screen.getByLabelText(AUTH_RU.login.passwordLabel), 'sekret-parol-1');
    await user.click(screen.getByRole('button', { name: AUTH_RU.login.submit }));

    expect(await screen.findByText(ERROR_MESSAGES_RU.INVALID_CREDENTIALS)).toBeInTheDocument();
    expect(screen.queryByText(serverMessage)).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* provider buttons                                                            */
/* -------------------------------------------------------------------------- */

describe('LoginPage — providers', () => {
  it('navigates the top-level document instead of opening a popup', async () => {
    const location = stubLocation();
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const user = userEvent.setup();

    try {
      renderWithProviders(<LoginPage />, '/login?next=%2Ftasks');
      await user.click(screen.getByRole('button', { name: AUTH_RU.login.providerGoogle }));

      expect(location.assign).toHaveBeenCalledTimes(1);
      const target = String(location.assign.mock.calls[0]?.[0]);
      expect(target).toContain('/api/auth/google/start');
      // The `next` param rides along as the server-validated `redirect`.
      expect(target).toContain('redirect=%2Ftasks');
      // A popup cannot work in an installed iOS PWA — it must never be used.
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      location.restore();
    }
  });

  it('offers every provider when the build carries no provider configuration', () => {
    expect(enabledOAuthProviders({})).toEqual(['google', 'telegram']);
  });

  it('hides a provider whose environment variable is absent', () => {
    expect(enabledOAuthProviders({ VITE_TELEGRAM_BOT_USERNAME: 'family_bot' })).toEqual([
      'telegram',
    ]);
    expect(
      enabledOAuthProviders({ VITE_GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' }),
    ).toEqual(['google']);
  });

  it('never lets a foreign redirect into the start URL', () => {
    expect(oauthStartUrl('google', { redirect: 'https://evil.example/steal' })).not.toContain(
      'redirect',
    );
    expect(oauthStartUrl('google', { redirect: '//evil.example' })).not.toContain('redirect');
  });
});

describe('LoginPage \u2014 a provider that failed before the user got there', () => {
  /**
   * `GET /api/auth/:provider/start` bounces back here when the flow dies before
   * the redirect. It is the only chance the app gets to say anything: Telegram's
   * own failure page for an unregistered BotFather domain is a bare English
   * line, «Bot domain invalid», served from Telegram's origin, so nothing of
   * ours ever runs on it.
   */
  it('names the provider and says it is misconfigured, not busy', () => {
    renderWithProviders(<LoginPage />, '/login?error=SERVICE_UNAVAILABLE&provider=telegram');

    expect(
      screen.getByText(AUTH_RU.errors.providerUnavailableTitle('Telegram')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(AUTH_RU.errors.providerUnavailableText('Telegram')),
    ).toBeInTheDocument();
    // «Попробуйте через минуту» would send the user into a retry loop that
    // cannot succeed - only the family admin can fix a bot domain.
    expect(screen.queryByText(ERROR_MESSAGES_RU.SERVICE_UNAVAILABLE)).not.toBeInTheDocument();
  });

  it('falls back to the shared catalogue when no provider is named', () => {
    renderWithProviders(<LoginPage />, '/login?error=SERVICE_UNAVAILABLE');
    expect(screen.getByText(ERROR_MESSAGES_RU.SERVICE_UNAVAILABLE)).toBeInTheDocument();
  });

  it('renders nothing at all for an unknown code or provider', () => {
    renderWithProviders(<LoginPage />, '/login?error=Bot%20domain%20invalid&provider=evil');
    // Never free-form text out of a query string.
    expect(screen.queryByText(/Bot domain invalid/)).not.toBeInTheDocument();
    expect(screen.queryByText(AUTH_RU.errors.formTitle)).not.toBeInTheDocument();
  });

  /**
   * `?oauth=replayed` — the callback ran twice for one sign-in and the second
   * one found the one-time state already spent. That used to render
   * `{"error":{"code":"BAD_REQUEST",…}}` into the address bar.
   *
   * It is not «не удалось войти»: if the first callback did issue the session,
   * `RedirectIfAuthenticated` takes the user into the app and this screen never
   * paints. Reaching it means the session really is absent, so the only honest
   * thing to say is that the link is spent — and to leave the buttons right
   * there.
   */
  it('treats a duplicated callback as a spent link, not as a failure', () => {
    renderWithProviders(<LoginPage />, '/login?oauth=replayed&provider=telegram');

    expect(screen.getByText(AUTH_RU.errors.replayedTitle)).toBeInTheDocument();
    expect(screen.getByText(AUTH_RU.errors.replayedText)).toBeInTheDocument();
    expect(screen.queryByText(AUTH_RU.errors.formTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ERROR_MESSAGES_RU.BAD_REQUEST)).not.toBeInTheDocument();
    // The way out is the same button they pressed a moment ago.
    expect(screen.getByRole('button', { name: /Telegram/ })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* install funnel                                                              */
/* -------------------------------------------------------------------------- */

describe('InstallPrompt', () => {
  function stubDisplayMode(standalone: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: standalone && query.includes('standalone'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  it('renders nothing when the app is already installed', () => {
    stubUserAgent(IPHONE_SAFARI);
    stubDisplayMode(true);

    renderWithProviders(<InstallPrompt force />);

    expect(screen.queryByTestId('install-card')).not.toBeInTheDocument();
    expect(screen.queryByText(AUTH_RU.install.cardTitle)).not.toBeInTheDocument();
  });

  it('tells a non-Safari iOS browser to open Safari instead of showing share steps', async () => {
    stubUserAgent(IPHONE_CHROME);
    stubDisplayMode(false);
    const user = userEvent.setup();

    renderWithProviders(<InstallPrompt force />);
    await user.click(screen.getByRole('button', { name: AUTH_RU.install.cardAction }));

    await waitFor(() => {
      expect(screen.getByText(AUTH_RU.install.safariOnlyTitle)).toBeInTheDocument();
    });
    expect(screen.getByText(AUTH_RU.install.safariOnlyText)).toBeInTheDocument();
    // The share-sheet steps would send this user hunting for a button that
    // cannot install anything.
    expect(screen.queryByText(AUTH_RU.install.stepShareIphone)).not.toBeInTheDocument();
  });

  it('shows the iPhone share steps in Safari', async () => {
    stubUserAgent(IPHONE_SAFARI, 5);
    stubDisplayMode(false);
    const user = userEvent.setup();

    renderWithProviders(<InstallPrompt force />);
    await user.click(screen.getByRole('button', { name: AUTH_RU.install.cardAction }));

    await waitFor(() => {
      expect(screen.getByText(AUTH_RU.install.stepShareIphone)).toBeInTheDocument();
    });
    expect(screen.getByText(AUTH_RU.install.stepAddToHome)).toBeInTheDocument();
  });

  it('stays hidden until the user has done something, and after a dismissal', async () => {
    stubUserAgent(IPHONE_SAFARI);
    stubDisplayMode(false);

    const { recordEngagement, shouldOfferInstall, dismissInstallPrompt } =
      await import('./components/install');

    expect(shouldOfferInstall()).toBe(false);
    recordEngagement();
    expect(shouldOfferInstall()).toBe(true);

    dismissInstallPrompt();
    expect(shouldOfferInstall()).toBe(false);
    // …and it may come back after roughly a fortnight.
    expect(shouldOfferInstall({ now: Date.now() + 15 * 24 * 60 * 60 * 1000 })).toBe(true);
  });
});
