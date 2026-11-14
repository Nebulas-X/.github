// pnpm.yml: the settings check against ADR-0021's settings, and the frozen-lockfile install, each on a must-pass and
// a must-fail fixture (ADR-0018 Confirmation). NBX_PNPM names the pnpm executable; without it the tests fail loudly,
// never skip (ADR-0032).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fixtureRepo, runStep, writeFiles } from './harness.mjs';

const LIMITS = { timeout: 15_000 };
const PNPM_VERSION = '12.18.0';

function pnpmEnv(env) {
  const pnpm = process.env.NBX_PNPM;
  assert.ok(pnpm, 'NBX_PNPM must name the pnpm executable (the self-test workflow sets it)');
  return { ...env, PATH: `${dirname(pnpm)}${delimiter}${env.PATH ?? process.env.PATH}` };
}

const SETTINGS = `minimumReleaseAge: 10080
trustPolicy: no-downgrade
strictDepBuilds: true
dangerouslyAllowAllBuilds: false
allowBuilds: {}
blockExoticSubdeps: true
saveExact: true
savePrefix: ''
engineStrict: true
`;

function workspace(label, { settings = SETTINGS, manifest = {} } = {}) {
  const { dir, env } = fixtureRepo(label, {
    'package.json': `${JSON.stringify({ name: 'fixture', private: true, packageManager: `pnpm@${PNPM_VERSION}`, ...manifest }, null, 2)}\n`,
  });
  const local = (name) => join(dir, '.local', name).replaceAll('\\', '/');
  writeFiles(dir, {
    'pnpm-workspace.yaml': `packages: []\nstoreDir: ${local('store')}\ncacheDir: ${local('cache')}\n${settings}`,
  });
  return { dir, env: pnpmEnv(env) };
}

const settingsCheck = ({ dir, env }) =>
  runStep('pnpm.yml', 'check-pnpm-settings', { cwd: dir, baseEnv: env, env: { NBX_PNPM_VERSION: PNPM_VERSION } });

test('a workspace with ADR-0021 settings passes the settings check', LIMITS, () => {
  const result = settingsCheck(workspace('pnpm-settings-ok'));
  assert.equal(result.status, 0, result.output);
});

test('a workspace without ADR-0021 settings fails the settings check', LIMITS, () => {
  const result = settingsCheck(workspace('pnpm-settings-none', { settings: '' }));
  assert.equal(result.status, 1, result.output);
  for (const key of ['minimumReleaseAge', 'trustPolicy', 'strictDepBuilds', 'blockExoticSubdeps', 'saveExact', 'engineStrict']) {
    assert.match(result.output, new RegExp(`${key} is`, 'u'));
  }
});

test('weakened settings, a wrong packageManager and a git dependency fail the settings check', LIMITS, () => {
  const weak = settingsCheck(workspace('pnpm-settings-weak', { settings: SETTINGS.replace('10080', '1440').replace('no-downgrade', 'off') }));
  assert.equal(weak.status, 1, weak.output);
  assert.match(weak.output, /minimumReleaseAge is 1440/u);
  const manager = settingsCheck(workspace('pnpm-settings-manager', { manifest: { packageManager: 'pnpm@11.0.0' } }));
  assert.equal(manager.status, 1, manager.output);
  const exotic = settingsCheck(workspace('pnpm-settings-git', { manifest: { dependencies: { x: 'github:example/x' } } }));
  assert.equal(exotic.status, 1, exotic.output);
  assert.match(exotic.output, /not the registry/u);
});

test('the frozen-lockfile install passes on a matching lockfile and fails on an unfrozen one', LIMITS, () => {
  // No packageManager here: pnpm would resolve itself from the registry, and this test stays offline.
  const fixture = workspace('pnpm-frozen', { manifest: { packageManager: undefined } });
  // The lockfile of a workspace without dependencies, made offline.
  const made = spawnSync(process.env.NBX_PNPM, ['install', '--lockfile-only', '--offline'], {
    cwd: fixture.dir,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  const frozen = runStep('pnpm.yml', 'install', { cwd: fixture.dir, baseEnv: fixture.env });
  assert.equal(frozen.status, 0, frozen.output);
  // A dependency added to package.json without updating the lockfile: the frozen install must refuse it.
  writeFiles(fixture.dir, {
    'package.json': `${JSON.stringify({ name: 'fixture', private: true, dependencies: { 'is-number': '7.0.0' } }, null, 2)}\n`,
  });
  const unfrozen = runStep('pnpm.yml', 'install', { cwd: fixture.dir, baseEnv: fixture.env });
  assert.notEqual(unfrozen.status, 0, unfrozen.output);
  assert.match(unfrozen.output, /ERR_PNPM_OUTDATED_LOCKFILE/u);
});
