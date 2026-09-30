CREATE TABLE "principal_permission_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"revoked_by_actor_type" text NOT NULL,
	"revoked_by_actor_id" text NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "join_requests" ADD COLUMN "decision_responsible_user_id" text;--> statement-breakpoint
ALTER TABLE "principal_permission_revocations" ADD CONSTRAINT "principal_permission_revocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_permission_revocations_unique_idx" ON "principal_permission_revocations" USING btree ("company_id","principal_type","principal_id","permission_key");