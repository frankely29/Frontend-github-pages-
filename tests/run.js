#!/usr/bin/env node
/**
 * tests/run.js — runs every tests/*.test.js in a child process.
 *
 * These are behavioural tests, not a syntax pass: each one loads the real
 * shipped source (or extracts the exact block under test out of it) so a
 * refactor that quietly drops a behaviour fails here instead of in the app.
 * Deliberately dependency-free — CI has plain node and nothing else.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('No *.test.js files found in tests/.');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const res = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (res.status !== 0) {
    failed += 1;
    console.log(`--- ${file} FAILED (exit ${res.status})`);
  }
}

console.log(
  failed
    ? `\n${failed} of ${files.length} test file(s) FAILED`
    : `\nall ${files.length} test file(s) passed`
);
process.exit(failed ? 1 : 0);
