-- Add missing RESTAURANTE value to StoreType enum (schema.prisma already declares it,
-- but the original migration that created the enum only included CAFETERIA and PAPELERIA).
ALTER TYPE "StoreType" ADD VALUE IF NOT EXISTS 'RESTAURANTE';
