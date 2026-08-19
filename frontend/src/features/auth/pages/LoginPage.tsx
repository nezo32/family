import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Home, Loader2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { loginRequestSchema, type LoginRequest } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/ui/form';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { ERROR_MESSAGES_RU, errorMessageRu } from '@/shared/api/errors-ru';
import { NEXT_PARAM } from '@/shared/lib/routes';
import { AUTH_RU } from '../locale';
import { useLogin } from '../hooks';
import { ProviderButtons } from '../components/ProviderButtons';
import RegisterPage from './RegisterPage';

/**
 * The sign-in screen.
 *
 * Three provider buttons plus email + password. Every provider button is a
 * **top-level navigation** (`api.ts :: startOAuth`) and never `window.open`: a
 * popup in an installed iOS PWA is either blocked or opens Safari in a separate
 * storage partition, so the `__Host-rt` cookie the callback sets would never
 * reach the app.
 *
 * Registration lives at `/login?mode=register` rather than its own path: the
 * route contract in `app/router.tsx` (which features must not edit) has no
 * `/register` entry, and a query parameter keeps the screen linkable, the back
 * button honest and the auth chunk single.
 */
export default function LoginPage() {
  const [params] = useSearchParams();
  const next = params.get(NEXT_PARAM);

  if (params.get('mode') === 'register') return <RegisterPage />;

  return <SignIn next={next} />;
}

function SignIn({ next }: { next: string | null }) {
  const [params] = useSearchParams();
  const [showPassword, setShowPassword] = useState(false);
  const mutation = useLogin(next);

  const form = useForm<LoginFormValues, unknown, LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(values);
  });

  // A failed OAuth round trip comes back as `/login?error=<ErrorCode>`. Only
  // codes we have a Russian sentence for are shown — never free-form text.
  const callbackError = translateErrorCode(params.get('error'));

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Home className="size-6" aria-hidden />
        </div>
        <CardTitle className="text-xl">{AUTH_RU.login.title}</CardTitle>
        <CardDescription className="text-balance">{AUTH_RU.login.subtitle}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {callbackError ? (
          <Alert variant="destructive">
            <AlertTitle>{AUTH_RU.errors.formTitle}</AlertTitle>
            <AlertDescription>{callbackError}</AlertDescription>
          </Alert>
        ) : null}

        <ProviderButtons next={next} />

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">{AUTH_RU.login.divider}</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {mutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{AUTH_RU.errors.formTitle}</AlertTitle>
            {/* Never the server's `message` — always the mapped Russian copy (D7). */}
            <AlertDescription>{errorMessageRu(mutation.error)}</AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-3">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{AUTH_RU.login.emailLabel}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      inputMode="email"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={AUTH_RU.login.emailPlaceholder}
                      className="h-11 text-base"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{AUTH_RU.login.passwordLabel}</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input
                        {...field}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        placeholder={AUTH_RU.login.passwordPlaceholder}
                        className="h-11 pr-11 text-base"
                      />
                    </FormControl>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      // 44px: `icon-sm` made the only control that rescues a
                      // mistyped password a 32px target.
                      className="absolute top-0.5 right-0.5 size-11 text-muted-foreground"
                      aria-label={
                        showPassword ? AUTH_RU.login.hidePassword : AUTH_RU.login.showPassword
                      }
                      onClick={() => {
                        setShowPassword((value) => !value);
                      }}
                    >
                      {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                    </Button>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="h-11 w-full" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {AUTH_RU.login.submitting}
                </>
              ) : (
                AUTH_RU.login.submit
              )}
            </Button>
          </form>
        </Form>

        <p className="text-center text-sm text-muted-foreground">
          {AUTH_RU.login.noAccountQuestion}{' '}
          <Link
            to={{ search: registerSearch(next) }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {AUTH_RU.login.registerLink}
          </Link>
        </p>

        <p className="text-center text-xs text-muted-foreground text-balance">
          {AUTH_RU.login.approvalNote}
        </p>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

type LoginFormValues = { email: string; password: string };

function registerSearch(next: string | null): string {
  const search = new URLSearchParams({ mode: 'register' });
  if (next) search.set(NEXT_PARAM, next);
  return `?${search.toString()}`;
}

/** Only codes with a translation are rendered; anything else is ignored. */
function translateErrorCode(code: string | null): string | null {
  if (!code) return null;
  if (!Object.prototype.hasOwnProperty.call(ERROR_MESSAGES_RU, code)) return null;
  return ERROR_MESSAGES_RU[code as keyof typeof ERROR_MESSAGES_RU];
}
