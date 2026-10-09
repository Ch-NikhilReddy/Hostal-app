-- H-5: admin audit log.
--
-- Append-only is enforced HERE, in the database, rather than by application
-- convention. A trail that application code is merely careful about is not evidence:
-- the next person to add an admin endpoint will not know to be careful, and a trail
-- that can be edited or removed proves nothing.
--
-- The trigger raises on UPDATE and DELETE. INSERT is untouched, obviously.
--
-- Note there is deliberately NO foreign key to User. When a compromised admin account
-- is deleted, the record of what it did has to survive — a trail that vanishes along
-- with the account is no use at exactly the moment it is needed. That is why actorPhone
-- is stored on the row rather than joined.

CREATE TABLE "admin_audit_log" (
    "id"          TEXT NOT NULL,
    "actorId"     TEXT,
    "actorPhone"  TEXT NOT NULL,
    "actorRole"   TEXT NOT NULL,
    "action"      TEXT NOT NULL,
    "targetType"  TEXT,
    "targetId"    TEXT,
    "summary"     TEXT NOT NULL,
    "metadata"    JSONB,
    "requestId"   TEXT,
    "ipAddress"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_log_createdAt_idx" ON "admin_audit_log"("createdAt");
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log"("action");
CREATE INDEX "admin_audit_log_targetType_targetId_idx" ON "admin_audit_log"("targetType", "targetId");
CREATE INDEX "admin_audit_log_actorId_idx" ON "admin_audit_log"("actorId");

-- The guarantee. Application code cannot soften this without a migration, and a
-- migration to soften it is a visible, reviewable event.
CREATE OR REPLACE FUNCTION admin_audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit_log is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_no_update
    BEFORE UPDATE ON "admin_audit_log"
    FOR EACH ROW EXECUTE FUNCTION admin_audit_log_is_append_only();

CREATE TRIGGER admin_audit_log_no_delete
    BEFORE DELETE ON "admin_audit_log"
    FOR EACH ROW EXECUTE FUNCTION admin_audit_log_is_append_only();

-- M-6 retention deliberately does NOT touch this table, and the trigger is why that
-- matters: a retention job cannot quietly prune the evidence. Anyone who wants old
-- rows gone has to drop a trigger, which shows up in a diff.
COMMENT ON TABLE "admin_audit_log" IS
  'Append-only trail of privileged actions. UPDATE and DELETE are blocked by trigger. '
  'No FK to User on purpose: the record must outlive the account.';