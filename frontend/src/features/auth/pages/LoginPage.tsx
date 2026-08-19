import { Home } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';

/**
 * PLACEHOLDER — owned by the `features/auth` agent.
 *
 * The real screen wires these buttons to the OAuth start endpoints
 * (`/api/auth/{google,apple,telegram}/start`) and carries the `next` query
 * param through the transaction so the user lands where they were headed.
 * Keep the file path and the default export.
 */
export default function LoginPage() {
  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Home className="size-6" aria-hidden />
        </div>
        <CardTitle className="text-xl">Семья</CardTitle>
        <CardDescription>
          Войдите, чтобы увидеть общие дела, календарь и покупки.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button className="w-full" disabled>
          Войти через Google
        </Button>
        <Button className="w-full" variant="outline" disabled>
          Войти через Apple
        </Button>
        <Button className="w-full" variant="outline" disabled>
          Войти через Telegram
        </Button>
        <p className="pt-2 text-center text-xs text-muted-foreground">
          Новый участник? После входа заявку подтвердит администратор семьи.
        </p>
      </CardContent>
    </Card>
  );
}
