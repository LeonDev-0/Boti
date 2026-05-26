-- Revert expiresAt back to DateTime (stored as TEXT in SQLite, same column type)
-- Clear any DD/MM/YYYY format strings that can't be parsed as ISO DateTime
UPDATE "User" SET "expiresAt" = NULL WHERE "expiresAt" IS NOT NULL AND "expiresAt" NOT GLOB '????-??-*';
