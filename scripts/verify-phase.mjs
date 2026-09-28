#!/usr/bin/env node
/**
 * Phase verification hook for PROGRESS.md.
 *
 *   npm run verify:phase -- <phase>              typecheck + full test suite, then record the result
 *   npm run verify:phase -- <phase> --complete   the same, and mark the phase ✅ Complete only if this run passed
 *   npm run verify:phase -- --self-test          check the PROGRESS.md update rules on sample text
 *
 * Safety rules:
 * - "✅ Complete" is only ever written by a run whose checks all passed, in this same process. A failing run
 *   records "❌ Verification failed" and exits non-zero.
 * - --complete is refused for a phase that was never worked on (skipped, not started, planned or already complete).
 * - Only the text between the phase-status and verification-log markers changes. The script refuses to run when
 *   the markers or the phase's row are missing, and writes through a temp file and a rename.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROGRESS_FILE = path.join(ROOT, 'PROGRESS.md');
const STATUS_MARKERS = ['<!-- phase-status:start -->', '<!-- phase-status:end -->'];
const LOG_MARKERS = ['<!-- verification-log:start -->', '<!-- verification-log:end -->'];
const LOG_PLACEHOLDER = '_No verification runs yet._';
/** A phase can be marked complete only from these statuses: in progress, implemented, or failed verification. */
const COMPLETABLE = ['🔨', '🧪', '❌'];

// ---------- PROGRESS.md edits (pure) ----------

function splitSection(text, [start, end]) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error(`PROGRESS.md is missing the ${start} … ${end} markers`);
  return { before: text.slice(0, a + start.length), body: text.slice(a + start.length, b), after: text.slice(b) };
}

function findRow(lines, phase) {
  const index = lines.findIndex((line) => line.startsWith(`| ${phase} |`));
  if (index === -1) throw new Error(`Phase ${phase} has no row in the PROGRESS.md status table`);
  const cells = lines[index].split('|').slice(1, -1).map((cell) => cell.trim());
  if (cells.length !== 4) throw new Error(`Phase ${phase}'s status row must have 4 columns`);
  return { index, cells };
}

function currentStatus(text, phase) {
  return findRow(splitSection(text, STATUS_MARKERS).body.split('\n'), phase).cells[2];
}

function canComplete(status) {
  return COMPLETABLE.some((prefix) => status.startsWith(prefix));
}

/** Applies one verification result: `{ phase, passed, complete, date, summary }`. A failed result never completes. */
function applyResult(text, result) {
  const status = splitSection(text, STATUS_MARKERS);
  const lines = status.body.split('\n');
  const { index, cells } = findRow(lines, result.phase);
  const day = result.date.slice(0, 10);
  const markComplete = result.passed === true && result.complete === true;
  if (markComplete) cells[2] = `✅ Complete (${day})`;
  else if (result.passed !== true) cells[2] = `❌ Verification failed (${day})`;
  else if (cells[2].startsWith('❌')) cells[2] = '🧪 Implemented — verifying';
  if (result.passed === true) cells[3] = day;
  lines[index] = `| ${cells.join(' | ')} |`;
  const withStatus = status.before + lines.join('\n') + status.after;

  const log = splitSection(withStatus, LOG_MARKERS);
  const entry = `- ${result.date} · Phase ${result.phase} · ${result.passed === true ? '✅ PASS' : '❌ FAIL'} · ${result.summary}${
    markComplete ? ' · marked complete' : ''
  }`;
  const earlier = log.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== LOG_PLACEHOLDER);
  return `${log.before}\n${[entry, ...earlier].join('\n')}\n${log.after}`;
}

// ---------- checks ----------

function run(label, args) {
  console.log(`\n▶ ${label}: npm ${args.join(' ')}`);
  const started = Date.now();
  const res = spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit' });
  return { ok: res.status === 0, seconds: Math.round((Date.now() - started) / 1000) };
}

function runChecks() {
  const typecheck = run('Typecheck', ['run', 'typecheck']);
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-phase-'));
  const reportFile = path.join(dir, 'vitest.json');
  try {
    const res = run('Tests', ['run', 'test', '-w', '@omni/server', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`]);
    let report = null;
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'));
    } catch {
      // No report means the run crashed before finishing; treated as a failure below.
    }
    const passed = report?.numPassedTests ?? 0;
    const failed = report?.numFailedTests ?? 0;
    const total = report?.numTotalTests ?? 0;
    const ok = res.ok && report?.success === true && failed === 0 && passed > 0;
    return { typecheck, tests: { ok, seconds: res.seconds, passed, failed, total, skipped: total - passed - failed } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- self-test ----------

function selfTest() {
  const sample = [
    '# Progress',
    '',
    STATUS_MARKERS[0],
    '| Phase | Title | Status | Last verified |',
    '|---|---|---|---|',
    '| 1 | One | 🔨 In progress | — |',
    '| 2 | Two | ⏳ Not started | — |',
    STATUS_MARKERS[1],
    '',
    LOG_MARKERS[0],
    LOG_PLACEHOLDER,
    LOG_MARKERS[1],
    '',
  ].join('\n');
  const date = '2026-09-27 10:00';
  const result = (phase, passed, complete) => ({ phase, passed, complete, date, summary: 'checks' });
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  const failedComplete = applyResult(sample, result('1', false, true));
  const passedComplete = applyResult(sample, result('1', true, true));
  const passedOnly = applyResult(sample, result('1', true, false));
  const recovered = applyResult(failedComplete, result('1', true, false));
  const checks = [
    ['a failing run never marks a phase complete', !failedComplete.includes('✅ Complete') && currentStatus(failedComplete, '1').startsWith('❌')],
    ['a failing run leaves Last verified unchanged', failedComplete.includes('| 1 | One | ❌ Verification failed (2026-09-27) | — |')],
    ['a passing --complete run marks the phase complete', currentStatus(passedComplete, '1') === '✅ Complete (2026-09-27)'],
    ['a passing run without --complete keeps the status', currentStatus(passedOnly, '1') === '🔨 In progress'],
    ['a passing run records Last verified', passedOnly.includes('| 1 | One | 🔨 In progress | 2026-09-27 |')],
    ['a pass after a failure clears the failed status', currentStatus(recovered, '1') === '🧪 Implemented — verifying'],
    ['the log keeps every run, newest first', recovered.indexOf('✅ PASS') < recovered.indexOf('❌ FAIL') && !recovered.includes(LOG_PLACEHOLDER)],
    ['other phases are untouched', passedComplete.includes('| 2 | Two | ⏳ Not started | — |')],
    ['text outside the markers is untouched', passedComplete.startsWith('# Progress\n\n') && passedComplete.endsWith(`${LOG_MARKERS[1]}\n`)],
    ['missing markers are refused', throws(() => applyResult('# Progress without markers', result('1', true, true)))],
    ['an unknown phase is refused', throws(() => applyResult(sample, result('7', true, true)))],
    ['only a phase that was worked on can be completed', canComplete('🔨 In progress') && canComplete('❌ Verification failed (2026-09-27)') && !canComplete('⏳ Not started') && !canComplete('📝 Planned — awaiting approval') && !canComplete('⏭️ Skipped (2026-09-27)') && !canComplete('✅ Complete (2026-09-27)')],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
  const failures = checks.filter(([, ok]) => !ok).length;
  console.log(failures ? `\n${failures} self-test check(s) failed` : `\nAll ${checks.length} self-test checks passed`);
  return failures ? 1 : 0;
}

// ---------- main ----------

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const phase = argv.find((arg) => /^\d+$/.test(arg));
  const complete = argv.includes('--complete');
  const unknown = argv.filter((arg) => arg !== phase && arg !== '--complete');
  if (!phase || unknown.length) {
    console.error('Usage: npm run verify:phase -- <phase> [--complete]   |   npm run verify:phase -- --self-test');
    return 2;
  }
  // Validate PROGRESS.md before spending minutes on the checks.
  const status = currentStatus(readFileSync(PROGRESS_FILE, 'utf8'), phase);
  if (complete && !canComplete(status)) {
    console.error(`Phase ${phase} is "${status}". Only a phase that is in progress or implemented can be marked complete.`);
    return 2;
  }

  const started = Date.now();
  const { typecheck, tests } = runChecks();
  const passed = typecheck.ok && tests.ok;
  const summary = [
    `typecheck ${typecheck.ok ? 'ok' : 'FAILED'}`,
    `tests ${tests.passed}/${tests.total} passed${tests.failed ? ` (${tests.failed} failed)` : ''}${tests.skipped ? ` (${tests.skipped} skipped)` : ''}${tests.ok ? '' : ' — FAILED'}`,
    `${Math.round((Date.now() - started) / 1000)}s`,
  ].join(' · ');

  // Re-read: PROGRESS.md may have been edited while the checks ran.
  const next = applyResult(readFileSync(PROGRESS_FILE, 'utf8'), { phase, passed, complete, date: localTimestamp(), summary });
  const tmp = `${PROGRESS_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, PROGRESS_FILE);

  console.log(`\n${passed ? '✅' : '❌'} Phase ${phase}: ${summary}`);
  if (complete) console.log(passed ? `Phase ${phase} marked complete in PROGRESS.md.` : `Phase ${phase} NOT marked complete: verification failed.`);
  return passed ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`verify-phase: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
