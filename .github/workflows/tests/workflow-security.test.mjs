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

// The runner modes: allow-nbx-ci admits exactly [self-hosted, nbx-ci] for secret-free jobs, forbid-self-hosted
// refuses every self-hosted label, and a caller chooses one of them. Each condition has a must-pass and a must-fail
// case. The secret commands are fake names, passed as a caller would pass its own.
const GUARD = 'github.event.pull_request.head.repo.full_name == github.repository';
const PUSH_OR_GUARD = `github.event_name != 'pull_request' || ${GUARD}`;
const PAIR_INPUT = `'["self-hosted","nbx-ci"]'`;
const COMMANDS = 'fake-vault-cli fake-helper.sh';
const PULL_AND_PUSH = '  pull_request:\n  push:\n    branches: [main]';

const labelJob = ({
  cond = PUSH_OR_GUARD,
  runsOn = '[self-hosted, nbx-ci]',
  permissions = '    permissions:\n      contents: read\n',
  extra = '',
  steps = '      - run: echo checked\n',
} = {}) =>
  `  checks:\n${cond === null ? '' : `    if: ${cond}\n`}    runs-on: ${runsOn}\n    timeout-minutes: 5\n${permissions}${extra}    steps:\n      - uses: actions/checkout@${SHA}\n${steps}`;

const callJob = ({
  cond = PUSH_OR_GUARD,
  runner = PAIR_INPUT,
  permissions = '    permissions:\n      contents: read\n',
  extra = '',
  uses = `Nebulas-X/.github/.github/workflows/workflow-security.yml@${SHA}`,
} = {}) =>
  `  security:\n${cond === null ? '' : `    if: ${cond}\n`}    uses: ${uses}\n${permissions}${extra}${runner === null ? '' : `    with:\n      runner: ${runner}\n`}`;

// A hosted job keeps every right: a secret, an environment, write permissions, id-token and a secret command.
const hostedJob = `  hosted:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    environment: staging
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - run: fake-vault-cli list
        env:
          TOKEN: \${{ secrets.NBX_FAKE }}
`;

const callerWorkflow = ({ on = PULL_AND_PUSH, env = '', jobs = [labelJob(), callJob(), hostedJob] } = {}) =>
  `name: ci\non:\n${on}\npermissions: {}\n${env}jobs:\n${jobs.join('')}`;

// commands: null leaves NBX_SECRET_COMMANDS out of the step's environment, as when nothing sets it.
const runners = (text, { forbid = 'false', allow = 'true', commands = COMMANDS } = {}) => {
  const dir = fixtureDir('workflow-runners');
  writeFiles(dir, { '.github/workflows/ci.yml': text });
  return runStep('workflow-security.yml', 'check-workflow-policy', {
    cwd: dir,
    env: { NBX_FORBID_SELF_HOSTED: forbid, NBX_ALLOW_NBX_CI: allow, NBX_SECRET_COMMANDS: commands ?? undefined },
  });
};

const mustPass = (cases, options) => {
  for (const [label, text] of cases) {
    const result = runners(text, options);
    assert.equal(result.status, 0, `${label}\n${text}\n${result.output}`);
  }
};

const mustFail = (cases, options) => {
  for (const [label, text, message] of cases) {
    const result = runners(text, options);
    assert.equal(result.status, 1, `${label}\n${text}\n${result.output}`);
    assert.match(result.output, message, label);
  }
};

const NOT_ADMITTED = /only ubuntu-24\.04 or exactly \[self-hosted, nbx-ci\] is admitted/u;
const BAD_INPUT = /the runner input is the JSON string "ubuntu-24\.04" or \["self-hosted","nbx-ci"\]/u;
const ONLY = (jobs) => callerWorkflow({ jobs });

test(
  'allow-nbx-ci admits ubuntu-24.04 and exactly [self-hosted, nbx-ci], and refuses every other runner',
  LIMITS,
  () => {
    mustPass([
      ['the pair, a call passing it and a hosted job', callerWorkflow()],
      ['the pair as a block list', ONLY([labelJob({ runsOn: '\n      - self-hosted\n      - nbx-ci' })])],
      ['the pair quoted', ONLY([labelJob({ runsOn: `['self-hosted', "nbx-ci"]` })])],
      ['ubuntu-24.04 alone', ONLY([labelJob({ cond: null, runsOn: 'ubuntu-24.04' })])],
    ]);
    mustFail([
      ['self-hosted alone', ONLY([labelJob({ runsOn: 'self-hosted' })]), NOT_ADMITTED],
      ['[self-hosted, linux]', ONLY([labelJob({ runsOn: '[self-hosted, linux]' })]), NOT_ADMITTED],
      ['nbx-ci alone', ONLY([labelJob({ runsOn: 'nbx-ci' })]), NOT_ADMITTED],
      ['a third label', ONLY([labelJob({ runsOn: '[self-hosted, nbx-ci, x64]' })]), NOT_ADMITTED],
      ['the labels reversed', ONLY([labelJob({ runsOn: '[nbx-ci, self-hosted]' })]), NOT_ADMITTED],
      [
        'a block list with a third label',
        ONLY([labelJob({ runsOn: '\n      - self-hosted\n      - nbx-ci\n      - linux' })]),
        NOT_ADMITTED,
      ],
      [
        'a runner group',
        ONLY([labelJob({ runsOn: '\n      group: runners\n      labels: [self-hosted, nbx-ci]' })]),
        /a runner group/u,
      ],
      ['a runner group in flow form', ONLY([labelJob({ runsOn: '{ group: runners }' })]), /a runner group/u],
      ['an expression', ONLY([labelJob({ runsOn: '${{ vars.RUNNER }}' })]), /an expression/u],
      ['another hosted image', ONLY([labelJob({ cond: null, runsOn: 'ubuntu-latest' })]), NOT_ADMITTED],
      ['the hosted label in a list', ONLY([labelJob({ cond: null, runsOn: '[ubuntu-24.04]' })]), NOT_ADMITTED],
    ]);
  },
);

test("allow-nbx-ci reads a call's runner input as JSON and admits only the two runners", LIMITS, () => {
  mustPass([
    ['the pair', ONLY([callJob()])],
    ['the pair, double-quoted YAML', ONLY([callJob({ runner: '"[\\"self-hosted\\", \\"nbx-ci\\"]"' })])],
    ['ubuntu-24.04 as JSON', ONLY([callJob({ cond: null, runner: `'"ubuntu-24.04"'` })])],
    ['no runner input', ONLY([callJob({ cond: null, runner: null })])],
  ]);
  mustFail([
    ['[self-hosted, linux]', ONLY([callJob({ runner: `'["self-hosted","linux"]'` })]), BAD_INPUT],
    ['self-hosted alone', ONLY([callJob({ runner: `'"self-hosted"'` })]), BAD_INPUT],
    ['an expression', ONLY([callJob({ runner: '${{ inputs.runner }}' })]), BAD_INPUT],
    ['a bare label, not JSON', ONLY([callJob({ cond: null, runner: 'ubuntu-24.04' })]), BAD_INPUT],
    ['a runner group', ONLY([callJob({ runner: `'{"group":"runners"}'` })]), BAD_INPUT],
  ]);
});

test(
  'allow-nbx-ci refuses the secrets context on [self-hosted, nbx-ci], in the job and in what it inherits',
  LIMITS,
  () => {
    mustPass([
      [
        'the word in a string literal',
        ONLY([labelJob({ steps: `      - run: echo "\${{ format('{0}', 'secrets.X') }}"\n` })]),
      ],
      ['a secret on a hosted job', ONLY([hostedJob])],
    ]);
    mustFail([
      [
        'a secret in a step env',
        ONLY([labelJob({ steps: '      - run: echo ok\n        env:\n          TOKEN: ${{ secrets.NBX_FAKE }}\n' })]),
        /reads the secrets context/u,
      ],
      [
        'toJSON(secrets) in a run',
        ONLY([labelJob({ steps: `      - run: echo '\${{ toJSON(secrets) }}'\n` })]),
        /reads the secrets context/u,
      ],
      [
        'secrets in a bare condition',
        ONLY([labelJob({ steps: "      - if: secrets.NBX_FAKE != ''\n        run: echo ok\n" })]),
        /reads the secrets context/u,
      ],
      [
        'secrets in the workflow env',
        callerWorkflow({ env: 'env:\n  TOKEN: ${{ secrets.NBX_FAKE }}\n', jobs: [labelJob()] }),
        /inherits the workflow's env or defaults/u,
      ],
      [
        'secrets in a call input',
        ONLY([
          callJob({
            runner: null,
            extra: `    with:\n      runner: ${PAIR_INPUT}\n      token: \${{ secrets.NBX_FAKE }}\n`,
          }),
        ]),
        /reads the secrets context/u,
      ],
    ]);
  },
);

test('allow-nbx-ci refuses a call that passes [self-hosted, nbx-ci] and secrets', LIMITS, () => {
  mustPass([
    ['a call without secrets', ONLY([callJob()])],
    [
      'a hosted call with secrets: inherit',
      ONLY([callJob({ cond: null, runner: null, extra: '    secrets: inherit\n' })]),
    ],
  ]);
  mustFail([
    [
      'secrets: inherit',
      ONLY([callJob({ extra: '    secrets: inherit\n' })]),
      /passes secrets to the called workflow/u,
    ],
    [
      'a named secret',
      ONLY([callJob({ extra: '    secrets:\n      token: ${{ secrets.NBX_FAKE }}\n' })]),
      /passes secrets to the called workflow/u,
    ],
  ]);
});

test('allow-nbx-ci refuses an environment on [self-hosted, nbx-ci]', LIMITS, () => {
  mustPass([['an environment on a hosted job', ONLY([hostedJob])]]);
  mustFail([
    ['an environment by name', ONLY([labelJob({ extra: '    environment: staging\n' })]), /names an environment/u],
    [
      'an environment as a map',
      ONLY([labelJob({ extra: '    environment:\n      name: staging\n' })]),
      /names an environment/u,
    ],
  ]);
});

test('allow-nbx-ci refuses a write permission or id-token on [self-hosted, nbx-ci]', LIMITS, () => {
  mustPass([
    ['contents: read', ONLY([labelJob()])],
    [
      'id-token: none',
      ONLY([labelJob({ permissions: '    permissions:\n      contents: read\n      id-token: none\n' })]),
    ],
    ['read-all', ONLY([labelJob({ permissions: '    permissions: read-all\n' })])],
    ['an empty map', ONLY([labelJob({ permissions: '    permissions: {}\n' })])],
    ['no job permissions, so the empty top level', ONLY([labelJob({ permissions: '' })])],
  ]);
  mustFail([
    [
      'pull-requests: write',
      ONLY([labelJob({ permissions: '    permissions:\n      contents: read\n      pull-requests: write\n' })]),
      /asks for pull-requests: write/u,
    ],
    [
      'id-token: write',
      ONLY([labelJob({ permissions: '    permissions:\n      contents: read\n      id-token: write\n' })]),
      /asks for id-token: write/u,
    ],
    [
      'id-token: read',
      ONLY([labelJob({ permissions: '    permissions:\n      id-token: read\n' })]),
      /asks for id-token: read/u,
    ],
    ['write-all', ONLY([labelJob({ permissions: '    permissions: write-all\n' })]), /asks for write-all/u],
    [
      'a write in flow form',
      ONLY([labelJob({ permissions: '    permissions: { contents: write }\n' })]),
      /asks for contents: write/u,
    ],
    [
      'a write on a call',
      ONLY([callJob({ permissions: '    permissions:\n      contents: write\n' })]),
      /asks for contents: write/u,
    ],
  ]);
});

test("allow-nbx-ci refuses the caller's secret commands on [self-hosted, nbx-ci]", LIMITS, () => {
  mustPass([
    ['a secret command on a hosted job', ONLY([hostedJob])],
    [
      'a secret command in a comment line',
      ONLY([labelJob({ steps: '      - run: |\n          # never fake-vault-cli here\n          echo ok\n' })]),
    ],
    ['a longer name that only contains one', ONLY([labelJob({ steps: '      - run: fake-vault-cli-docs\n' })])],
  ]);
  mustFail([
    [
      'a command',
      ONLY([labelJob({ steps: '      - run: fake-vault-cli list\n' })]),
      /runs the secret command fake-vault-cli/u,
    ],
    [
      'a sourced script',
      ONLY([labelJob({ steps: '      - run: source ./scripts/fake-helper.sh\n' })]),
      /runs the secret command fake-helper\.sh/u,
    ],
    [
      'a command with quotes inside',
      ONLY([labelJob({ steps: '      - run: fake-"vault"-cli list\n' })]),
      /runs the secret command fake-vault-cli/u,
    ],
    [
      'a command in the workflow env',
      callerWorkflow({ env: 'env:\n  TOOL: fake-vault-cli\n', jobs: [labelJob()] }),
      /runs the secret command fake-vault-cli/u,
    ],
  ]);
});

test('allow-nbx-ci needs the secret commands: an empty, blank or missing list fails', LIMITS, () => {
  const NEEDS = /allow-nbx-ci needs secret-commands/u;
  const running = ONLY([labelJob({ steps: '      - run: fake-vault-cli list\n' })]);
  for (const [label, commands] of [
    ['an empty list', ''],
    ['a blank list', ' \t '],
    ['no list at all', null],
  ]) {
    mustFail([[label, running, NEEDS]], { commands });
  }
  const hosted = ONLY([labelJob({ cond: null, runsOn: 'ubuntu-24.04' })]);
  mustPass([['no list without allow-nbx-ci', hosted]], { allow: 'false', commands: null });
  mustPass([['no list under forbid-self-hosted', hosted]], { forbid: 'true', allow: 'false', commands: '' });
});

test('a call to this check declares the secret commands in secret-commands without running them', LIMITS, () => {
  const declaring = (inputs, uses) =>
    callJob({
      runner: null,
      uses,
      extra: `    with:\n      runner: ${PAIR_INPUT}\n      allow-nbx-ci: true\n${inputs}`,
    });
  const LIST = `      secret-commands: ${COMMANDS}\n`;
  mustPass([
    ['the list on one line', ONLY([declaring(LIST)])],
    [
      'the list folded',
      ONLY([declaring('      secret-commands: >-\n        fake-vault-cli\n        fake-helper.sh\n')]),
    ],
  ]);
  const RUNS = /runs the secret command fake-vault-cli/u;
  mustFail([
    ['a secret command in another input of the call', ONLY([declaring(`${LIST}      tool: fake-vault-cli\n`)]), RUNS],
    [
      'the list on a call to another workflow',
      ONLY([declaring(LIST, `Nebulas-X/.github/.github/workflows/repository-hygiene.yml@${SHA}`)]),
      RUNS,
    ],
    [
      'this check pinned by a tag',
      ONLY([declaring(LIST, 'Nebulas-X/.github/.github/workflows/workflow-security.yml@v1')]),
      RUNS,
    ],
  ]);
});

test(
  'allow-nbx-ci refuses [self-hosted, nbx-ci] on a pull_request trigger without the fork guard in its own if',
  LIMITS,
  () => {
    mustPass([
      ['the guard for push and pull request', ONLY([labelJob()])],
      ['the guard alone', callerWorkflow({ on: '  pull_request:', jobs: [labelJob({ cond: GUARD })] })],
      ['the guard as a conjunct', ONLY([labelJob({ cond: `${GUARD} && vars.ENABLED == 'true'` })])],
      [
        'the push-or-guard form in parentheses, folded',
        ONLY([labelJob({ cond: `>-\n      (${PUSH_OR_GUARD}) &&\n      vars.ENABLED == 'true'` })]),
      ],
      ['the push-or-guard form in one expression', ONLY([labelJob({ cond: `\${{ ${PUSH_OR_GUARD} }}` })])],
      [
        'no pull_request trigger',
        callerWorkflow({ on: '  push:\n    branches: [main]', jobs: [labelJob({ cond: null })] }),
      ],
    ]);
    const NO_GUARD = /without the fork guard/u;
    mustFail([
      ['no condition', ONLY([labelJob({ cond: null })]), NO_GUARD],
      ['another condition only', ONLY([labelJob({ cond: "vars.ENABLED == 'true'" })]), NO_GUARD],
      ['the guard negated', ONLY([labelJob({ cond: `!(${GUARD})` })]), NO_GUARD],
      ['the guard beside a top-level ||', ONLY([labelJob({ cond: `${GUARD} || github.actor == 'x'` })]), NO_GUARD],
      [
        'the push-or-guard form beside a top-level ||',
        ONLY([labelJob({ cond: `${PUSH_OR_GUARD} || vars.X == 'true'` })]),
        NO_GUARD,
      ],
      ['the guard in a partial expression', ONLY([labelJob({ cond: `\${{ ${GUARD} }} && true` })]), NO_GUARD],
      [
        'the guard on a step only',
        ONLY([labelJob({ cond: null, steps: `      - if: ${GUARD}\n        run: echo ok\n` })]),
        NO_GUARD,
      ],
      [
        'pull_request in an event list',
        ONLY([labelJob({ cond: null })]).replace(`on:\n${PULL_AND_PUSH}`, 'on: [push, pull_request]'),
        NO_GUARD,
      ],
      ['a call without the guard', ONLY([callJob({ cond: null })]), NO_GUARD],
    ]);
  },
);

test('forbid-self-hosted refuses the pair and a call passing it; both modes on is an error', LIMITS, () => {
  const forbid = { forbid: 'true', allow: 'false' };
  mustPass(
    [
      [
        'hosted jobs and a call on the hosted runner',
        ONLY([labelJob({ cond: null, runsOn: 'ubuntu-24.04' }), callJob({ cond: null, runner: `'"ubuntu-24.04"'` })]),
      ],
      [
        'an expression for the reusable workflows here',
        ONLY([labelJob({ cond: null, runsOn: '${{ fromJSON(inputs.runner) }}' })]),
      ],
    ],
    forbid,
  );
  mustFail(
    [
      ['the pair', ONLY([labelJob()]), /forbidden here/u],
      ['a call passing the pair', ONLY([callJob()]), /forbidden here/u],
    ],
    forbid,
  );
  mustFail(
    [
      [
        'both modes on',
        ONLY([labelJob({ cond: null, runsOn: 'ubuntu-24.04' })]),
        /forbid-self-hosted and allow-nbx-ci are both on/u,
      ],
    ],
    {
      forbid: 'true',
      allow: 'true',
    },
  );
});
