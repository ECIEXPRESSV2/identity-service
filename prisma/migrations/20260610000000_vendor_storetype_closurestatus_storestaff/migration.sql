-- Idempotent migration: handles partial state from failed db push attempts.

-- ─── 1. StoreType enum ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "StoreType" AS ENUM ('CAFETERIA', 'PAPELERIA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. ClosureStatus enum ───────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ClosureStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 3. Rename SELLER → VENDOR in SystemRole ─────────────────────────────────
-- Clean up any leftover intermediate types from failed attempts
DROP TYPE IF EXISTS "SystemRole_new";
DROP TYPE IF EXISTS "SystemRole_old";

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'VENDOR'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SystemRole')
  ) THEN
    -- Cast column to TEXT first so we can freely update values and drop the type
    ALTER TABLE "roles" ALTER COLUMN "systemRole" TYPE TEXT
      USING "systemRole"::text;

    -- Replace SELLER values while column is TEXT
    UPDATE "roles" SET "systemRole" = 'VENDOR' WHERE "systemRole" = 'SELLER';

    -- Drop old enum and recreate with VENDOR
    DROP TYPE "SystemRole";
    CREATE TYPE "SystemRole" AS ENUM ('BUYER', 'VENDOR', 'ADMIN', 'ANALYST');

    -- Restore column to the new enum type
    ALTER TABLE "roles" ALTER COLUMN "systemRole" TYPE "SystemRole"
      USING "systemRole"::"SystemRole";
  END IF;
END $$;

-- ─── 4. users — emailVerified ────────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;

-- ─── 5. stores — type column + unique name ───────────────────────────────────
ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "type" "StoreType" NOT NULL DEFAULT 'CAFETERIA';

-- Remove bootstrap default (Prisma expects no server default)
ALTER TABLE "stores" ALTER COLUMN "type" DROP DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS "stores_name_key" ON "stores"("name");

-- ─── 6. store_closures — status + cancellation fields ────────────────────────
ALTER TABLE "store_closures"
  ADD COLUMN IF NOT EXISTS "status"      "ClosureStatus" NOT NULL DEFAULT 'SCHEDULED',
  ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT NOW();

ALTER TABLE "store_closures" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- ─── 7. store_staff — new table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "store_staff" (
    "id"         TEXT NOT NULL,
    "storeId"    TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "assignedBy" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "removedBy"  TEXT,
    "removedAt"  TIMESTAMP(3),

    CONSTRAINT "store_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "store_staff_storeId_userId_key"
  ON "store_staff"("storeId", "userId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_staff_storeId_fkey'
  ) THEN
    ALTER TABLE "store_staff"
      ADD CONSTRAINT "store_staff_storeId_fkey"
        FOREIGN KEY ("storeId") REFERENCES "stores"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_staff_userId_fkey'
  ) THEN
    ALTER TABLE "store_staff"
      ADD CONSTRAINT "store_staff_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 8. outbox_events — idempotencyKey ───────────────────────────────────────
ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT NOT NULL DEFAULT '';

UPDATE "outbox_events"
  SET "idempotencyKey" = id
  WHERE "idempotencyKey" = '';

ALTER TABLE "outbox_events" ALTER COLUMN "idempotencyKey" DROP DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_idempotencyKey_key"
  ON "outbox_events"("idempotencyKey");
