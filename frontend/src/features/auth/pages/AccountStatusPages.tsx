import type { ComponentType } from 'react';
import { Ban, Clock, PauseCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { ROUTES } from '@/shared/lib/routes';

/**
 * The three account-status screens (D3).
 *
 * All three are **fully unauthenticated pages**: a `pending_approval` user gets
 * no session at all — not a limited one, not a scoped one — so these must render
 * without `/api/me` ever succeeding. They are reachable directly by URL and
 * from the API layer's 403 handling (`shared/api/refresh.ts`).
 */

function StatusScreen(props: {
  icon: ComponentType<{ className?: string }>;
  tone: 'neutral' | 'warning' | 'danger';
  title: string;
  description: string;
  hint?: string;
  action?: { to: string; label: string };
}) {
  const Icon = props.icon;
  const tone =
    props.tone === 'danger'
      ? 'bg-destructive/10 text-destructive'
      : props.tone === 'warning'
        ? 'bg-warning/15 text-warning-foreground'
        : 'bg-muted text-muted-foreground';

  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div
          className={`mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl ${tone}`}
        >
          <Icon className="size-6" aria-hidden />
        </div>
        <CardTitle className="text-lg text-balance">{props.title}</CardTitle>
        <CardDescription className="text-balance">{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-center">
        {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
        {props.action ? (
          <Button asChild variant="outline" className="w-full">
            <Link to={props.action.to}>{props.action.label}</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PendingApprovalPage() {
  return (
    <StatusScreen
      icon={Clock}
      tone="neutral"
      title="Заявка отправлена"
      description="Администратор семьи получил уведомление и скоро подтвердит доступ."
      hint="Мы пришлём сообщение, как только заявку одобрят. Можно закрыть эту страницу."
      action={{ to: ROUTES.login, label: 'Войти другим способом' }}
    />
  );
}

export function RejectedPage() {
  return (
    <StatusScreen
      icon={Ban}
      tone="danger"
      title="Заявка отклонена"
      description="Администратор семьи не подтвердил доступ к этому пространству."
      hint="Если это ошибка — попросите кого-нибудь из семьи отправить приглашение заново."
      action={{ to: ROUTES.login, label: 'Вернуться ко входу' }}
    />
  );
}

export function SuspendedPage() {
  return (
    <StatusScreen
      icon={PauseCircle}
      tone="warning"
      title="Доступ приостановлен"
      description="Администратор временно закрыл доступ к семье."
      hint="Данные сохранены. Доступ вернётся сразу после снятия ограничения."
      action={{ to: ROUTES.login, label: 'Вернуться ко входу' }}
    />
  );
}

export default PendingApprovalPage;
