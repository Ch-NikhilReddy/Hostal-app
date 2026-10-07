/**
 * Prints the real column names for a table.
 *
 * Needed whenever a raw SQL query touches a Prisma-mapped table: `@@map` renames
 * the table, but the COLUMNS keep their camelCase names and must be double-quoted
 * in raw SQL. Guessing this costs a `column does not exist` at runtime.
 *
 * Usage: node scripts/show-columns.mjs beds [bookings,room_types,...]
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
for (const candidate of [path.join(repoRoot, 'api', '.env'), path.join(repoRoot, '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const tables = process.argv.slice(2);
if (tables.length === 0) {
  console.error('Usage: node scripts/show-columns.mjs <table> [<table> ...]');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position`,
      table,
    );

    console.log(`\n${table}`);
    if (rows.length === 0) {
      console.log('  (no such table)');
      continue;
    }
    for (const r of rows) {
      const nullable = r.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      console.log(`  ${String(r.column_name).padEnd(24)} ${String(r.data_type).padEnd(28)} ${nullable}`);
    }
  }
} finally {
  await prisma.$disconnect();
}