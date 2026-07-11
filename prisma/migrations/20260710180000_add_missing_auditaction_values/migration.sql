-- Add missing AuditAction values (schema.prisma already declares them, but the original
-- init migration's enum only included USER_CREATED, USER_UPDATED, USER_DEACTIVATED,
-- ROLE_ASSIGNED, ROLE_REVOKED, STORE_CREATED, STORE_UPDATED, STORE_CLOSURE_CREATED,
-- PERMISSION_GRANTED, PERMISSION_REVOKED — these three were added to the schema later
-- (store staff + closure cancellation use cases) without a corresponding migration).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STORE_CLOSURE_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STORE_STAFF_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STORE_STAFF_REMOVED';
