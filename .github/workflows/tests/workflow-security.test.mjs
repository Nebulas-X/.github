// workflow-security.yml: the pin, permission and timeout policy on must-pass and must-fail workflows (ADR-0017
// «Actions»; ADR-0021). The placeholder pin, forty zeros, fails as an unreplaced pin.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureDir, runStep, writeFiles } from './harness.mjs';

const LIMITS = { timeout: 15_000 };
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const ZERO = '0'.repeat(40);

const workflow = ({ permissions = 'permissions: {}', uses = `actions/checkout@${SHA}`, timeout = '    timeout-minutes: 5', extraJob = '' } = {}) =>
  `name: ci
on:
  pull_request:
${permissions}
jobs:
  build:
    runs-on: ubuntu-24.04
${timeout}
    steps:
      - uses: ${uses}
  hygiene:
    uses: Nebulas-X/.github/.github/workflows/repository-hygiene.yml@${SHA}
${extraJob}`;

const policy = (text, forbid = 'false') => {
  const dir = fixtureDir('workflow-policy');
  writeFiles(dir, { '.github/workflows/ci.yml': text });
  return runStep('workflow-security.yml', 'check-workflow-policy', { cwd: dir, env: { NBX_FORBID_SELF_HOSTED: forbid } });
};

test('a workflow pinned by full SHA, with permissions: {} and timeouts, passes', LIMITS, () => {
  const result = policy(workflow());
  assert.equal(result.status, 0, result.output);
  const local = policy(workflow({ extraJob: '  local:\n    uses: $/.github/workflows/pr-title.yml\n' }));
  assert.equal(local.status, 0, local.output);
});

test('tag pins, placeholder pins, missing permissions, missing timeouts and banned triggers fail', LIMITS, () => {
  const cases = [
    [workflow({ uses: 'actions/checkout@v7' }), /not pinned by a full-length commit SHA/u],
    [workflow({ uses: `actions/checkout@${SHA.slice(0, 7)}` }), /not pinned by a full-length commit SHA/u],
    [workflow({ uses: `actions/checkout@${ZERO}` }), /unreplaced placeholder pin/u],
    [workflow({ permissions: 'permissions:\n  contents: write' }), /permissions: \{\}» is missing/u],
    [workflow({ timeout: '' }), /has no timeout-minutes/u],
    [workflow().replace('  pull_request:', '  pull_request_target:'), /pull_request_target is banned/u],
    [workflow({ uses: 'docker://alpine:3.22' }), /not pinned by digest/u],
  ];
  for (const [text, message] of cases) {
    const result = policy(text);
    assert.equal(result.status, 1, `${text}\n${result.output}`);
    assert.match(result.output, message);
  }
});

test('a self-hosted job that reads a secret fails, and any self-hosted job fails where forbidden', LIMITS, () => {
  const selfHosted = `  runner:
    runs-on: [self-hosted, linux]
    timeout-minutes: 5
    steps:
      - run: echo "$TOKEN"
        env:
          TOKEN: \${{ secrets.NBX_FAKE }}
`;
  const withSecret = policy(workflow({ extraJob: selfHosted }));
  assert.equal(withSecret.status, 1, withSecret.output);
  assert.match(withSecret.output, /runs self-hosted and reads a secret/u);
  const plain = workflow({ extraJob: selfHosted.replace(/      - run[\s\S]*$/u, '      - run: echo ok\n') });
  assert.equal(policy(plain).status, 0);
  const forbidden = policy(plain, 'true');
  assert.equal(forbidden.status, 1, forbidden.output);
  assert.match(forbidden.output, /forbidden here/u);
});
