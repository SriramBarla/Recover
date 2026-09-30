// Entry for `node --test --test-concurrency=1 tests/e2e/`. Node 22 does not expand a directory
// argument into test files; it loads the directory's index.js instead, so this file imports every
// suite, students first so the staff and accessibility suites find fresh data.
// `node --test --test-concurrency=1 "tests/e2e/*.e2e.test.mjs"` runs each suite in its own process.
await import('./student.e2e.test.mjs');
await import('./staff.e2e.test.mjs');
await import('./a11y.e2e.test.mjs');
