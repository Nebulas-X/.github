// pr-title.yml: a Conventional Commit title passes; anything else fails (ADR-0019).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDir, runStep } from './harness.mjs';

const TYPES = 'build chore ci docs feat fix perf refactor revert style test';
const check = (title, event = 'pull_request') =>
  runStep('pr-title.yml', 'check-pr-title', {
    cwd: fixtureDir('pr-title'),
    env: { NBX_EVENT_NAME: event, NBX_PR_TITLE: title, NBX_TYPES: TYPES, NBX_MAX_LENGTH: '100' },
  });

test('Conventional Commit titles pass', { timeout: 15_000 }, () => {
  for (const title of ['feat(quoting): add the multicolour quote', 'fix: refuse an expired session', 'ci!: pin every action']) {
    const result = check(title);
    assert.equal(result.status, 0, `${title}\n${result.output}`);
  }
});

test('titles that are not Conventional Commits fail', { timeout: 15_000 }, () => {
  for (const title of [
    'Add the multicolour quote',
    'feature: add the quote',
    'feat(Quoting): add the quote',
    'feat:add the quote',
    'feat: ',
    `feat: ${'x'.repeat(100)}`,
  ]) {
    const result = check(title);
    assert.equal(result.status, 1, `${title}\n${result.output}`);
    assert.match(result.output, /::error title=pr-title::/u);
  }
});

test('events other than pull requests say so and pass', { timeout: 15_000 }, () => {
  const result = check('', 'push');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /pull requests only/u);
});
