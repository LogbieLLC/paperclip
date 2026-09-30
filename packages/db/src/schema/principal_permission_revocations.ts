import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * A permission that a person deliberately took away from a principal.
 *
 * Revoking a grant deletes its `principal_permission_grants` row, and a missing
 * row alone cannot tell "never granted" apart from "revoked on purpose". The
 * server re-applies default grants on its own (startup backfill, root-CEO and
 * built-in agent defaults, invite replays, plugins), so without this record a
 * revoked permission silently came back. Automatic grant paths skip every key
 * recorded here; only an explicit grant by a person clears the record.
 */
export const principalPermissionRevocations = pgTable(
  "principal_permission_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    revokedByActorType: text("revoked_by_actor_type").notNull(),
    revokedByActorId: text("revoked_by_actor_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueRevocationIdx: uniqueIndex("principal_permission_revocations_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.permissionKey,
    ),
  }),
);
