import { ToggleSwitch } from "./ui/toggle-switch";

/**
 * The board's switch for an agent's `joins:approve` grant. The root CEO holds
 * it by default so it can approve agent join requests on the board's behalf.
 * Turning it off is permanent until a board member turns it back on: the
 * server never restores it on its own, and no agent can change it.
 */
export function JoinApprovalPermissionRow({
  grants,
  disabled,
  onChange,
}: {
  grants: ReadonlyArray<{ permissionKey: string }> | undefined;
  disabled: boolean;
  onChange: (canApproveJoins: boolean) => void;
}) {
  const canApproveJoins = (grants ?? []).some((grant) => grant.permissionKey === "joins:approve");
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <div className="space-y-1">
        <div>Can approve agent join requests</div>
        <p className="text-xs text-muted-foreground">
          Lets this agent approve or decline agents that ask to join. Human join requests always need a board member.
          Only a board member can change this.
        </p>
      </div>
      <ToggleSwitch
        checked={canApproveJoins}
        onCheckedChange={() => onChange(!canApproveJoins)}
        disabled={disabled}
      />
    </div>
  );
}
