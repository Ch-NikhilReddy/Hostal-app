/**
 * Backup and restore for the HostelMitra database.
 *
 *   node scripts/db-backup.mjs                     take a backup
 *   node scripts/db-backup.mjs --list              list existing backups
 *   node scripts/db-backup.mjs --verify <file>     restore into a scratch database and check it
 *   node scripts/db-backup.mjs --prune             delete backups past retention
 *
 * pg_dump/pg_restore run inside the Postgres container, so nothing needs installing on
 * the host. Custom format (-Fc), not plain SQL: it compresses, and a single table can
 * be recovered with --table if that is ever needed.
 *
 * NO SECRETS IN THIS FILE, and none on any command line. The password reaches
 * pg_dump through the container's own environment. Passing a connection string as an
 * argument would put it in the process table where any local user could read it.
 *
 * Backups land in api/backups/, which is gitignored. A database dump in version
 * control is a data leak waiting to be found.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = path.join(repoRoot, 'api', 'backups');

const SERVICE = 'db';
const PG_USER = process.env.POSTGRES_USER ?? 'hostelmitra';
const PG_DB = process.env.POSTGRES_DB ?? 'hostelmitra';

/**
 * Retention, documented in docs/backup-restore.md.
 *
 * Development-tier numbers. A production host writing to object storage would keep
 * daily for 30 days and monthly for a year; that is a storage-cost decision and it is
 * flagged there rather than chosen here.
 */
const RETENTION_DAYS = 30;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function docker(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: repoRoot,
    });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout: Buffer.concat(out), stderr: err })
        : reject(new Error(`docker ${args[0]} ${args[1] ?? ''} exited ${code}: ${err.trim()}`)),
    );
    child.stdin.end();
    void opts;
  });
}

/**
 * Resolve the running container's id.
 *
 * `docker exec db` does not work: `db` is the Compose SERVICE name, while the container
 * is named hostelmitra-db via container_name. Looking the id up from the service means
 * this keeps working if that name changes, and fails loudly with an actionable message
 * when the database is not running instead of talking to the wrong thing.
 */
async function containerId() {
  const { stdout } = await docker(['compose', 'ps', '-q', SERVICE]);
  const id = stdout.toString().trim().split('\n')[0]?.trim();
  if (!id) {
    throw new Error(`no running container for service "${SERVICE}" — start it with: npm run db:up`);
  }
  return id;
}

/** Run a command inside the database container. */
async function inContainer(id, argv) {
  return docker(['exec', id, ...argv]);
}

/** Copy a file out of the container. docker cp needs the container, not the service. */
function copyOut(id, from, to) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['cp', `${id}:${from}`, to], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`docker cp exited ${c}`))));
  });
}

function copyIn(id, from, to) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['cp', from, `${id}:${to}`], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`docker cp in exited ${c}`))));
  });
}

/**
 * Exact row counts per table.
 *
 * NOT pg_stat_user_tables.n_live_tup. That column is a planner estimate that only
 * becomes accurate after ANALYZE, so it reported bookings=0 and colleges=0 on a
 * database that held 16 bookings and 12 colleges — which would have made a restore
 * check pass while the data was actually missing. Verification that can be fooled by
 * an estimate is not verification.
 */
async function rowCounts(id, database) {
  const { stdout: namesOut } = await inContainer(id, [
    'psql', '-U', PG_USER, '-d', database, '-tAc',
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '_prisma%' ORDER BY tablename;",
  ]);

  const tables = namesOut.toString().split('\n').map((l) => l.trim()).filter(Boolean);
  if (tables.length === 0) return {};

  const union = tables
    .map((t) => `SELECT '${t}' AS t, count(*)::text AS n FROM "${t}"`)
    .join(' UNION ALL ');

  const { stdout } = await inContainer(id, [
    'psql', '-U', PG_USER, '-d', database, '-tAc', union,
  ]);

  const counts = {};
  for (const line of stdout.toString().split('\n')) {
    const [table, n] = line.split('|');
    if (table && n !== undefined) counts[table.trim()] = Number(n.trim());
  }
  return counts;
}

async function backup() {
  const id = await containerId();
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  const file = path.join(BACKUP_DIR, `hostelmitra-${stamp()}.dump`);
  const inContainerPath = '/tmp/hostelmitra-backup.dump';

  await inContainer(id, [
    'pg_dump', '-U', PG_USER, '-d', PG_DB,
    '-Fc', '--no-owner', '--no-privileges',
    '-f', inContainerPath,
  ]);

  // pg_dump can exit 0 while writing a warning; confirm the artefact is non-empty
  // inside the container before trusting it enough to copy out.
  const probe = await inContainer(id, ['test', '-s', inContainerPath]);
  if (probe.stdout.toString().trim() !== '') throw new Error('pg_dump produced an empty file');

  await copyOut(id, inContainerPath, file);
  await inContainer(id, ['rm', '-f', inContainerPath]);

  const size = statSync(file).size;
  if (size < 1024) throw new Error(`backup is only ${size} bytes — that is not a database`);

  const counts = await rowCounts(id, PG_DB);
  writeFileSync(
    `${file}.json`,
    JSON.stringify(
      { takenAt: new Date().toISOString(), bytes: size, database: PG_DB, tables: counts },
      null,
      2,
    ),
  );

  console.log(`\n  backup written`);
  console.log(`    ${file}`);
  console.log(`    ${(size / 1024).toFixed(1)} KiB`);
  console.log(`    ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join('  ')}\n`);
  return file;
}

/**
 * Restore into a SCRATCH database and compare row counts.
 *
 * Deliberately not into the live database. A restore that overwrites the only good
 * copy turns a backup into an outage. The scratch database is created, restored into,
 * measured and dropped — which proves the dump is readable without touching anything
 * that matters.
 */
async function verify(file) {
  const id = await containerId();
  const scratch = 'hostelmitra_restore_check';
  const manifestPath = `${file}.json`;
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

  if (!manifest) {
    throw new Error(`no manifest beside ${path.basename(file)} — cannot check row counts`);
  }

  console.log(`\n  restoring into a scratch database (the live one is never touched)\n`);
  await inContainer(id, ['psql', '-U', PG_USER, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${scratch}`]);
  await inContainer(id, ['psql', '-U', PG_USER, '-d', 'postgres', '-c', `CREATE DATABASE ${scratch}`]);

  try {
    await copyIn(id, file, '/tmp/hostelmitra-restore.dump');

    const { stderr } = await inContainer(id, [
      'pg_restore', '-U', PG_USER, '-d', scratch,
      '--no-owner', '--no-privileges', '--exit-on-error',
      '/tmp/hostelmitra-restore.dump',
    ]);

    const errors = stderr
      .split('\n')
      .filter((l) => l.includes('ERROR') || l.includes('FATAL'));
    if (errors.length) {
      throw new Error(`pg_restore reported errors:\n      ${errors.slice(0, 5).join('\n      ')}`);
    }

    const restored = await rowCounts(id, scratch);
    const tables = Object.keys(restored);
    if (tables.length === 0) throw new Error('restore produced no tables');

    console.log('  table                    captured   restored');
    let mismatches = 0;
    for (const table of tables.sort()) {
      const was = manifest.tables?.[table];
      const ok = was === undefined || was === restored[table];
      if (!ok) mismatches += 1;
      console.log(
        `  ${table.padEnd(24)}${String(was ?? '?').padStart(9)}${String(restored[table]).padStart(10)}  ${ok ? 'ok' : 'MISMATCH'}`,
      );
    }

    // The other direction too: a table present at capture time but absent after the
    // restore is just as much a failure as a differing count.
    for (const table of Object.keys(manifest.tables ?? {})) {
      if (!(table in restored)) {
        mismatches += 1;
        console.log(`  ${table.padEnd(24)}${String(manifest.tables[table]).padStart(9)}${'absent'.padStart(10)}  MISSING`);
      }
    }

    if (mismatches > 0) throw new Error(`${mismatches} table(s) did not match the manifest`);

    console.log(`\n  RESTORE VERIFIED — ${tables.length} tables, all counts match\n`);
    return true;
  } finally {
    await inContainer(id, ['psql', '-U', PG_USER, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${scratch}`]);
    await inContainer(id, ['rm', '-f', '/tmp/hostelmitra-restore.dump']);
  }
}

function list() {
  if (!existsSync(BACKUP_DIR)) {
    console.log('\n  no backups yet — run: node scripts/db-backup.mjs\n');
    return;
  }
  const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump')).sort().reverse();
  if (!files.length) {
    console.log('\n  no backups yet\n');
    return;
  }
  console.log('');
  for (const f of files) {
    const s = statSync(path.join(BACKUP_DIR, f));
    console.log(
      `  ${f}  ${(s.size / 1024).toFixed(1)} KiB  ${s.mtime.toISOString().slice(0, 16).replace('T', ' ')}`,
    );
  }
  console.log(`\n  ${files.length} backup(s)\n`);
}

async function prune() {
  if (!existsSync(BACKUP_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const f of readdirSync(BACKUP_DIR)) {
    const p = path.join(BACKUP_DIR, f);
    if (statSync(p).mtimeMs < cutoff) {
      rmSync(p, { force: true });
      removed += 1;
    }
  }
  console.log(`\n  removed ${removed} file(s) older than ${RETENTION_DAYS} days\n`);
}

const [, , cmd, arg] = process.argv;

try {
  switch (cmd) {
    case undefined:
      await backup();
      break;
    case '--list':
      list();
      break;
    case '--verify': {
      if (!arg) throw new Error('usage: --verify <file>');
      if (!existsSync(arg)) throw new Error(`no such backup: ${arg}`);
      await verify(path.resolve(arg));
      break;
    }
    case '--prune':
      await prune();
      break;
    default:
      console.log('usage: db-backup.mjs [--list | --verify <file> | --prune]');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n  FAILED: ${err.message}\n`);
  process.exitCode = 1;
}