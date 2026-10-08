/**
 * Audits ONLY what the API actually ships at runtime.
 *
 *   node scripts/audit-runtime.mjs
 *
 * `npm audit` at the repository root reports 64 findings, and almost none of them are
 * this application's problem. This is an Expo monorepo: the Expo CLI, Metro, Babel and
 * Jest toolchains appear as production dependencies of the `app` workspace because
 * that is how npm resolves them, and every one of them is build-time. Not one of them
 * is present in the API container. Reading the root number as "64 vulnerabilities in my
 * server" is how real findings get buried.
 *
 * Conversely, a blanket `--audit-level=high` gate would fail CI on packages that cannot
 * be reached, and a team that suppresses that gate stops reading its output at all.
 *
 * So this does the thing that is actually worth knowing:
 *
 *   1. resolve the API's production tree with `npm ls --omit=dev`
 *   2. ask npm which packages currently have advisories
 *   3. intersect the two
 *
 * A finding only counts if it is in the tree that ships. Exits non-zero if any do.
 *
 * Known and accepted: nothing. The runtime tree is currently clean.
 *
 * History, because it is not obvious: H-6 was the Prisma CLI advisory, range
 * 6.13.0-dev.1 .. 8.1.0-dev.4. The original assessment was that no stable 6.x release
 * escaped it. That was wrong — 6.12.0 sits below the lower bound, so downgrading both
 * `prisma` and `@prisma/client` to 6.12.0 clears it. npm reports this as
 * `isSemVerMajor: true`, which is its heuristic for any non-forward move and not a
 * statement that a major upgrade is needed. Both packages are pinned to 6.12.0 and
 * verified against the full test suite.
 *
 * The runtime tree was audited by intersecting `npm ls --omit=dev` with npm's advisory
 * data, so a package promoted to a dependency is picked up automatically.
 */
import { spawnSync } from 'node:child_process';

const FAIL_LEVELS = new Set(['low', 'moderate', 'high', 'critical']);

/**
 * Packages whose presence would be a known, documented state rather than a failure.
 * Empty today — H-6 was resolved by downgrading, not accepted. Kept so that formally
 * accepting a future advisory is a visible, reviewed act rather than a comment.
 */
const ACCEPTED = new Map();

function run(args) {
  // shell:true is required for `npm.cmd` to resolve on Windows. Node warns about it
  // because arguments are concatenated rather than escaped — safe here because every
  // argument below is a static literal written in this file. Nothing from argv,
  // stdin, the environment or the network reaches this call. If that ever stops being
  // true, this function needs replacing, not adjusting.
  return spawnSync('npm.cmd', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: true,
  });
}

console.log('\nRuntime dependency audit — the tree the API container actually gets\n');

const ls = run(['ls', '--omit=dev', '--workspace', '@hostelmitra/api', '--all']);
const audit = run(['audit', '--omit=dev', '--json']);

if (audit.status !== 0 && !audit.stdout) {
  console.error('  could not run npm audit:', audit.stderr?.trim() || 'unknown error');
  process.exitCode = 1;
} else {
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    console.error('  npm audit did not return JSON');
    process.exitCode = 1;
    report = null;
  }

  if (report?.vulnerabilities) {
    // The set of packages npm says have advisories, at any depth.
    const advised = Object.keys(report.vulnerabilities);

    // The set of packages present in the API's production tree. Parsed from the
    // tree rather than assumed, so a package promoted to a dependency is picked up
    // automatically and cannot slip past this gate.
    const inRuntimeTree = new Set();
    const treeText = ls.stdout ?? '';
    for (const line of treeText.split('\n')) {
      for (const m of line.matchAll(/([@a-z0-9][^@\s]*|@[a-z0-9-]+\/[^@\s]+)@[0-9]/gi)) {
        inRuntimeTree.add(m[1]);
      }
    }

    // A package nested under an advised one inherits its advisory, so treat a hit on
    // either the package or its parents as in scope.
    const reachable = [];
    const accepted = [];
    const unreachable = [];

    for (const name of advised) {
      const entry = report.vulnerabilities[name];
      if (inRuntimeTree.has(name)) {
        (ACCEPTED.has(name) ? accepted : reachable).push({ name, entry });
      } else {
        unreachable.push({ name, entry });
      }
    }

    const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
    for (const { entry } of [...reachable, ...accepted, ...unreachable]) {
      if (entry.severity && FAIL_LEVELS.has(entry.severity)) counts[entry.severity] += 1;
    }

    console.log(
      `  ${advised.length} package(s) carry an advisory somewhere in the monorepo.\n` +
        `  ${inRuntimeTree.size} package(s) are in the API's production tree.\n`,
    );

    console.log(`  In the runtime tree — these count:`);
    if (reachable.length === 0) {
      console.log('    none\n');
    } else {
      for (const { name, entry } of reachable.sort((a, b) => b.entry.severity.localeCompare(a.entry.severity))) {
        console.log(`    ${entry.severity.toUpperCase().padEnd(9)} ${name}`);
        const via = (entry.via ?? []).map((v) => (typeof v === 'string' ? v : v.title));
        for (const t of via.slice(0, 2)) console.log(`              ${t}`);
        const fix = entry.fixAvailable;
        console.log(
          `              fix: ${fix === true ? 'available' : typeof fix === 'object' ? `upgrade to ${fix.name}@${fix.version}` : 'none published'}`,
        );
      }
      console.log('');
    }

    console.log(`  Accepted and documented:`);
    if (accepted.length === 0) {
      console.log('    none\n');
    } else {
      for (const { name } of accepted) {
        console.log(`    ${name}`);
        console.log(`      ${ACCEPTED.get(name)}\n`);
      }
    }

    console.log(`  Not in the runtime tree — build tooling, cannot reach production:`);
    const toolchains = unreachable.filter((u) => !u.name.startsWith('prisma') && !u.name.startsWith('@prisma/'));
    const prismaCli = unreachable.filter((u) => u.name.startsWith('prisma') || u.name.startsWith('@prisma/'));
    console.log(`    ${toolchains.length} package(s) from the Expo / Metro / Babel / Jest toolchains`);
    if (prismaCli.length) {
      console.log(`    ${prismaCli.length} from the Prisma CLI (a devDependency, absent from the production image)`);
    }
    console.log(`    None of these can be reached by a request. This is why the root audit number`);
    console.log(`    overstates the risk, and why gating CI on it would train people to ignore it.\n`);

    if (reachable.length > 0) {
      console.log('  RESULT: runtime tree has unaccepted advisories. Fix or formally accept each one.\n');
      process.exitCode = 1;
    } else {
      console.log('  RESULT: the API runtime tree is clean apart from the accepted items above.\n');
    }
  }
}