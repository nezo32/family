import { ROLE_DESCRIPTIONS_RU, ROLE_LABELS_RU, type Role } from '@family/shared';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { ADMIN_RU } from '../locale';

/**
 * "Одобрить" step two: pick the role.
 *
 * Deliberately a **two-tap flow**: «Одобрить» opens this sheet, tapping a role
 * approves. Approving a new family member from a phone in the kitchen is the
 * common case; a form with a select, a weight field and a submit button is a
 * desktop habit that costs four taps and a keyboard.
 *
 * Every option carries `ROLE_DESCRIPTIONS_RU` next to `ROLE_LABELS_RU`, because
 * "Подросток" alone does not tell an admin what the person will be able to see.
 * The list is whatever `assignableRoles()` returned — the picker cannot offer a
 * role the server would refuse.
 */
export function ApproveRoleSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memberName: string;
  roles: readonly Role[];
  pendingRole: Role | null;
  onPick: (role: Role) => void;
}) {
  const busy = props.pendingRole !== null;

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-2xl pb-safe"
        data-scroll-pane
      >
        <SheetHeader className="text-left">
          <SheetTitle>{ADMIN_RU.approveSheetTitle}</SheetTitle>
          <SheetDescription>{ADMIN_RU.approveSheetDescription}</SheetDescription>
        </SheetHeader>

        <p className="px-4 pb-2 text-sm font-medium text-foreground">{props.memberName}</p>

        {props.roles.length === 0 ? (
          <div className="px-4 pb-6">
            <p className="text-sm font-medium text-foreground">{ADMIN_RU.noAssignableRolesTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {ADMIN_RU.noAssignableRolesDescription}
            </p>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-2 px-4 pb-2">
              {props.roles.map((role) => (
                <li key={role}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      props.onPick(role);
                    }}
                    className="flex min-h-11 w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-foreground">
                        {ROLE_LABELS_RU[role]}
                      </span>
                      <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
                        {ROLE_DESCRIPTIONS_RU[role]}
                      </span>
                    </span>
                    {props.pendingRole === role ? (
                      <InlineSpinner className="mt-0.5 text-muted-foreground" />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            <p className="px-4 pb-4 text-xs text-muted-foreground">
              {busy ? ADMIN_RU.approving : ADMIN_RU.approveSheetHint}
            </p>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
