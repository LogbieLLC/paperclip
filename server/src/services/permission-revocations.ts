import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { principalPermissionRevocations } from "@paperclipai/db";
import type { PrincipalType } from "@paperclipai/shared";

/**
 * Durable record of permissions that a person or agent deliberately revoked.
 *
 * The server grants permissions on its own in several places (the startup
 * backfill of human role defaults, root-CEO and built-in agent defaults, invite
 * replays, plugins, imports). Those automatic grants must never undo a
 * revocation. Only an explicit grant by a person clears the record; an agent's
 * explicit grant does not, so no agent can reverse a board decision.
 */

type Executor = Pick<Db, "select" | "insert" | "delete">;
type LockExecutor = Pick<Db, "execute">;

export type PermissionDecisionActor = {
  actorType: "user" | "agent";
  actorId: string;
};

type PrincipalRef = {
  companyId: string;
  principalType: PrincipalType | string;
  principalId: string;
};

function principalConditions(principal: PrincipalRef) {
  return [
    eq(principalPermissionRevocations.companyId, principal.companyId),
    eq(principalPermissionRevocations.principalType, principal.principalType),
    eq(principalPermissionRevocations.principalId, principal.principalId),
  ];
}

/**
 * Serializes every grant and revocation write for one principal. Take it at
 * the start of the transaction that reads revocations and writes grants, so an
 * automatic grant cannot read "not revoked", lose a race to a revoke, and then
 * insert the grant anyway. Released when the transaction ends.
 */
export async function lockPrincipalPermissions(tx: LockExecutor, principal: PrincipalRef) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:principal-permissions:${principal.companyId}:${principal.principalType}:${principal.principalId}`}, 0))`,
  );
}

export async function listRevokedPermissionKeys(db: Executor, principal: PrincipalRef): Promise<Set<string>> {
  const rows = await db
    .select({ permissionKey: principalPermissionRevocations.permissionKey })
    .from(principalPermissionRevocations)
    .where(and(...principalConditions(principal)));
  return new Set(rows.map((row) => row.permissionKey));
}

export async function isPermissionRevoked(db: Executor, principal: PrincipalRef, permissionKey: string) {
  const rows = await db
    .select({ id: principalPermissionRevocations.id })
    .from(principalPermissionRevocations)
    .where(and(...principalConditions(principal), eq(principalPermissionRevocations.permissionKey, permissionKey)))
    .limit(1);
  return rows.length > 0;
}

export async function recordPermissionRevocations(
  db: Executor,
  principal: PrincipalRef,
  permissionKeys: Iterable<string>,
  decidedBy: PermissionDecisionActor,
) {
  const keys = [...new Set(permissionKeys)];
  if (keys.length === 0) return;
  const now = new Date();
  await db
    .insert(principalPermissionRevocations)
    .values(
      keys.map((permissionKey) => ({
        companyId: principal.companyId,
        principalType: principal.principalType,
        principalId: principal.principalId,
        permissionKey,
        revokedByActorType: decidedBy.actorType,
        revokedByActorId: decidedBy.actorId,
        revokedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        principalPermissionRevocations.companyId,
        principalPermissionRevocations.principalType,
        principalPermissionRevocations.principalId,
        principalPermissionRevocations.permissionKey,
      ],
      set: {
        revokedByActorType: decidedBy.actorType,
        revokedByActorId: decidedBy.actorId,
        revokedAt: now,
      },
    });
}

export async function clearPermissionRevocations(
  db: Executor,
  principal: PrincipalRef,
  permissionKeys: Iterable<string>,
) {
  const keys = [...new Set(permissionKeys)];
  if (keys.length === 0) return;
  await db
    .delete(principalPermissionRevocations)
    .where(and(...principalConditions(principal), inArray(principalPermissionRevocations.permissionKey, keys)));
}

/**
 * Applies an explicit grant decision to the revocation record and returns the
 * keys the decision may actually grant. A person's grant clears the matching
 * revocations. An agent's grant, like an automatic one, may not restore a
 * revoked key.
 */
export async function resolveGrantableKeys(
  db: Executor,
  principal: PrincipalRef,
  requestedKeys: Iterable<string>,
  decidedBy: PermissionDecisionActor | null,
): Promise<Set<string>> {
  const requested = new Set(requestedKeys);
  if (decidedBy?.actorType === "user") {
    await clearPermissionRevocations(db, principal, requested);
    return requested;
  }
  const revoked = await listRevokedPermissionKeys(db, principal);
  return new Set([...requested].filter((key) => !revoked.has(key)));
}
