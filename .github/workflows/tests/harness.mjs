// The test harness of the reusable workflows. Each test runs a check exactly as CI runs it: the harness reads the
// step's `run` script and `shell` out of the workflow file by the step's `id`, writes the script to a scratch folder,
// and runs it inside a fixture with the environment the workflow would pass. Fixtures are assembled at run time in a
// fresh folder under NBX_TEST_TMP (the dev container's /tmp, or the worktree's ignored .local/tmp on a workstation),
// falling back to the system's temporary folder; they are left in place for the container to discard (ruling R-W43).
// Git runs only inside those fixture repositories, with an isolated configuration, so no test reads the machine's git
// settings or touches a real repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The `run` script and `shell` of the step with this `id` in this workflow file. */
export function stepScript(workflow, id) {
  const lines = readFileSync(join(workflowsDir, workflow), 'utf8').split(/\r?\n/u);
  const indent = (line) => /^ */u.exec(line)[0].length;
  const idAt = lines.findIndex((line) => line.trim() === `id: ${id}`);
  if (idAt < 0) throw new Error(`${workflow}: no step with id «${id}»`);
  let start = idAt;
  while (start > 0 && !/^\s*-\s/u.test(lines[start])) start -= 1;
  const stepIndent = indent(lines[start]);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || indent(lines[end]) > stepIndent)) end += 1;
  const step = lines.slice(start, end);
  const shellLine = step.find((line) => /^\s*shell:/u.test(line));
  const shell = shellLine ? shellLine.replace(/^\s*shell:\s*/u, '').trim() : 'bash';
  const runAt = step.findIndex((line) => /^\s*run:\s*/u.test(line));
  if (runAt < 0) throw new Error(`${workflow}: step «${id}» has no run script`);
  const inline = step[runAt].replace(/^\s*run:\s*/u, '');
  if (inline !== '|') return { shell, script: `${inline}\n` };
  const body = [];
  for (const line of step.slice(runAt + 1)) {
    if (line.trim() !== '' && indent(line) <= indent(step[runAt])) break;
    body.push(line);
  }
  const depth = Math.min(...body.filter((line) => line.trim() !== '').map(indent));
  return { shell, script: `${body.map((line) => line.slice(depth)).join('\n').trimEnd()}\n` };
}

/** A fresh, empty fixture folder. */
export function fixtureDir(label) {
  const root = process.env.NBX_TEST_TMP ?? tmpdir();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `nbx-${label}-`));
}

/** Writes files into a folder: a map of relative path to content. */
export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** The environment of every fixture command: git isolated from the machine's settings. */
export function fixtureEnv(dir) {
  const gitconfig = join(dir, '..', `${dir.split(/[\\/]/u).pop()}.gitconfig`);
  writeFileSync(
    gitconfig,
    '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n',
  );
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_AUTHOR_DATE: '2026-11-14T12:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-14T12:00:00Z',
  };
}

/** Runs git in a fixture repository; throws on failure. */
export function git(dir, env, ...args) {
  const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A fixture git repository with these files staged (and committed when `commit` is a message). */
export function fixtureRepo(label, files, { commit } = {}) {
  const dir = fixtureDir(label);
  const env = fixtureEnv(dir);
  git(dir, env, 'init', '-q');
  writeFiles(dir, files);
  git(dir, env, 'add', '-A');
  if (commit) git(dir, env, 'commit', '-q', '-m', commit);
  return { dir, env };
}

/** Runs the step's script in `cwd` with extra environment variables; returns the exit status and the output. */
export function runStep(workflow, id, { cwd, env = {}, baseEnv = process.env }) {
  const { shell, script } = stepScript(workflow, id);
  const scratch = fixtureDir(`step-${id}`);
  let command;
  let args;
  if (shell === 'node {0}') {
    const file = join(scratch, `${id}.cjs`);
    writeFileSync(file, script);
    command = process.execPath;
    args = [file];
  } else if (shell === 'bash') {
    const file = join(scratch, `${id}.sh`);
    writeFileSync(file, script);
    command = 'bash';
    args = ['--noprofile', '--norc', '-e', '-o', 'pipefail', file];
  } else {
    throw new Error(`${workflow}: step «${id}» uses the unsupported shell «${shell}»`);
  }
  const result = spawnSync(command, args, {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 12_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
