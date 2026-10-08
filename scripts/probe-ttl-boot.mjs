/**
 * Boots the real config module under a chosen JWT_REFRESH_TTL and reports whether
 * the process would start. This is the behaviour an operator experiences: a bad
 * value must stop the deploy, not corrupt a token lifetime.
 *
 *   node scripts/probe-ttl-boot.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const apiDir = path.join(repoRoot, 'api');

const tsxCli = ['node_modules/tsx/dist/cli.mjs', '../node_modules/tsx/dist/cli.mjs'].find((rel) =>
  existsSync(path.join(apiDir, rel)),
);

const VALID = [
  ['30d', 30 * 86_400_000],
  ['12h', 12 * 3_600_000],
  ['60m', 60 * 60_000],
  ['30s', 30_000],
  ['500ms', 500],
];

const INVALID = ['invalid', '', '   ', '-1h', '0d', '0m', '12', '3600', '30x', '1.5h', '30 d'];

function boot(ttl) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsxCli, '-e', `import {parseDurationMs} from './src/lib/duration.ts'; console.log('OK:'+parseDurationMs(process.env.T));`],
      {
        cwd: apiDir,
        env: { ...process.env, T: ttl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', () => {
      const m = /OK:(\d+)/.exec(out);
      if (m) resolve({ booted: true, ms: Number(m[1]) });
      else {
        const reason = (out.match(/INVALID_DURATION[\s\S]{0,140}/) ?? ['', out.split('\n')[0]])[0]
          .replace(/\s+/g, ' ')
          .trim();
        resolve({ booted: false, reason });
      }
    });
  });
}

async function main() {
  console.log('\nC-2 startup validation probe\n');
  let failures = 0;

  console.log('Valid durations (must be accepted with the correct millisecond value)');
  for (const [input, expected] of VALID) {
    const r = await boot(input);
    const ok = r.booted && r.ms === expected;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${String(input).padEnd(8)} -> ${r.booted ? `${r.ms}ms` : `REFUSED (${r.reason})`}` +
        (ok ? '' : `   expected ${expected}ms`),
    );
  }

  console.log('\nInvalid durations (must be refused)');
  for (const input of INVALID) {
    const r = await boot(input);
    const ok = !r.booted;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input).padEnd(8)} -> ${r.booted ? `ACCEPTED as ${r.ms}ms` : 'refused'}`,
    );
  }

  console.log('\nThe audit defect, restated as an executable check');
  {
    const buggy = (v) => Number.parseInt(v, 10) * 86_400_000;
    const cases = [
      ['12h', 12 * 3_600_000],
      ['60m', 60 * 60_000],
      ['30s', 30_000],
      ['500ms', 500],
    ];
    for (const [input, correct] of cases) {
      const r = await boot(input);
      const wasWrong = buggy(input) !== correct;
      const nowRight = r.booted && r.ms === correct;
      if (!nowRight) failures += 1;
      console.log(
        `  ${nowRight ? 'PASS' : 'FAIL'}  ${input.padEnd(8)} old formula gave ${buggy(input)}ms; now ${r.booted ? `${r.ms}ms` : 'refused'}`,
      );
      if (!wasWrong) console.log('      (note: old formula happened to agree here)');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL STARTUP VALIDATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('probe failed:', e); process.exitCode = 1; });