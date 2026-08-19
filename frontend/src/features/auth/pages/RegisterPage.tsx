import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Loader2, ShieldCheck, UserPlus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { registerRequestSchema, type RegisterRequest } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/ui/form';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { errorMessageRu } from '@/shared/api/errors-ru';
import { NEXT_PARAM, ROUTES } from '@/shared/lib/routes';
import { AUTH_RU } from '../locale';
import { useRegister } from '../hooks';
import { ProviderButtons } from '../components/ProviderButtons';

/**
 * Registration.
 *
 * The single most important thing this screen does is set the expectation that
 * signing up is a *request*: a new member is created `pending_approval`, gets no
 * session at all (D3), and lands on `/auth/pending`. Someone who expects to be
 * inside the app after tapping the button and instead sees a waiting screen
 * assumes it broke — so the approval sentence is stated twice, before the form
 * and on the submit path.
 *
 * Reached at `/login?mode=register` (the route contract owns `/login`), and
 * kept as a default-exported page so it can be given its own path unchanged.
 */
export default function RegisterPage() {
  const [params] = useSearchParams();
  const next = params.get(NEXT_PARAM);
  const [showPassword, setShowPassword] = useState(false);
  const mutation = useRegister(next);

  const form = useForm<RegisterFormValues, unknown, RegisterRequest>({
    resolver: zodResolver(registerRequestSchema),
    defaultValues: { displayName: '', email: '', password: '' },
  });

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(values);
  });

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <UserPlus className="size-6" aria-hidden />
        </div>
        <CardTitle className="text-xl">{AUTH_RU.register.title}</CardTitle>
        <CardDescription className="text-balance">{AUTH_RU.register.subtitle}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <Alert>
          <ShieldCheck aria-hidden />
          <AlertTitle>{AUTH_RU.register.approvalBannerTitle}</AlertTitle>
          <AlertDescription>{AUTH_RU.register.approvalBannerText}</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <p className="text-center text-xs text-muted-foreground text-balance">
            {AUTH_RU.register.providersHint}
          </p>
          <ProviderButtons next={next} />
        </div>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">{AUTH_RU.login.divider}</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {mutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{AUTH_RU.errors.registerFormTitle}</AlertTitle>
            {/* Mapped from the `ErrorCode`; the server's English `message` never renders (D7). */}
            <AlertDescription>{errorMessageRu(mutation.error)}</AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-3">
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{AUTH_RU.register.nameLabel}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="text"
                      autoComplete="name"
                      autoCapitalize="words"
                      placeholder={AUTH_RU.register.namePlaceholder}
                      className="h-11 text-base"
                    />
                  </FormControl>
                  <FormDescription>{AUTH_RU.register.nameHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{AUTH_RU.register.emailLabel}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={AUTH_RU.register.emailPlaceholder}
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
                  <FormLabel>{AUTH_RU.register.passwordLabel}</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input
                        {...field}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder={AUTH_RU.register.passwordPlaceholder}
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
                  <FormDescription>{AUTH_RU.register.passwordHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="h-11 w-full" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {AUTH_RU.register.submitting}
                </>
              ) : (
                AUTH_RU.register.submit
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground text-balance">
              {AUTH_RU.register.approvalBannerText}
            </p>
          </form>
        </Form>

        <p className="text-center text-sm text-muted-foreground">
          {AUTH_RU.register.haveAccountQuestion}{' '}
          <Link
            to={loginSearch(next)}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {AUTH_RU.register.loginLink}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

type RegisterFormValues = { displayName: string; email: string; password: string };

function loginSearch(next: string | null): string {
  if (!next) return ROUTES.login;
  return `${ROUTES.login}?${NEXT_PARAM}=${encodeURIComponent(next)}`;
}
