#!/usr/bin/env node
/**
 * 发版：改版本号 → 跑一遍检查 → 提交 → 打 tag。
 *
 *   pnpm release 2.1.0
 *
 * **不推送**。推送是唯一不可撤销的一步（tag 一旦上去，Actions 就会往 Docker Hub
 * 发布正式版本号，而正式版本号不该被重写），所以它留给人手动确认。
 * 脚本最后会把要执行的两条命令原样打出来。
 *
 * 语义化版本怎么选：
 *   主版本 3.0.0  —— 有破坏性改动（配置项改名、数据要迁移、接口不兼容）
 *   次版本 2.1.0  —— 加了新功能，老用户升级不用做任何事
 *   补丁号 2.0.1  —— 只修 bug，用户看不到任何新东西
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

/** 与 apps/server/src/version.test.ts 里的清单同源。 */
const MANIFESTS = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
  'tools/migrate-legacy/package.json',
];

/** 服务端 `/api/health` 返回的版本号，硬写在源码里（见 version.test.ts 的说明）。 */
const VERSION_SOURCE = 'apps/server/src/routes/health.ts';

const CHECKS = [
  ['构建 shared', ['pnpm', '--filter', '@firemail/shared', 'build']],
  ['类型检查', ['pnpm', 'typecheck']],
  ['前端 lint', ['pnpm', '--filter', '@firemail/web', 'lint']],
  ['测试', ['pnpm', 'test']],
  ['构建', ['pnpm', 'build']],
];

function main() {
  const args = process.argv.slice(2);
  const skipChecks = args.includes('--skip-checks');
  const version = args.find((arg) => !arg.startsWith('--'));

  if (!version) fail('用法：pnpm release <版本号>，例如 pnpm release 2.1.0');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`「${version}」不是合法的版本号。要 主版本.次版本.补丁 三段数字，例如 2.1.0`);
  }

  const tag = `v${version}`;
  const current = readJson('package.json').version;

  requireCleanTree();
  requireBranch('master');
  requireTagIsNew(tag);
  requireForward(current, version);

  say(`准备发版：${current} → ${version}`);

  if (skipChecks) {
    say('已跳过检查（--skip-checks）。CI 仍然会在 push 之后跑一遍。');
  } else {
    for (const [label, command] of CHECKS) {
      say(`  ${label}…`);
      run(command[0], command.slice(1));
    }
  }

  for (const path of MANIFESTS) bumpManifest(path, version);
  bumpVersionSource(version);
  say(`已改完 ${String(MANIFESTS.length + 1)} 处版本号`);

  run('git', ['add', ...MANIFESTS, VERSION_SOURCE]);
  run('git', ['commit', '-m', `chore(release): v${version}`]);
  run('git', ['tag', '-a', tag, '-m', `${tag}\n\n发布说明见 GitHub Release，由 Actions 从提交记录自动生成。`]);

  say('');
  say(`已提交并打好 tag ${tag}。**还没推送**，确认无误后执行：`);
  say('');
  say(`    git push origin master`);
  say(`    git push origin ${tag}`);
  say('');
  say('推 tag 之后 Actions 会自动：');
  say(`  · 构建镜像并推 Docker Hub：${version} / ${major(version)}.${minor(version)} / ${major(version)} / latest`);
  say('  · 在 GitHub 上建一个 Release，发布说明从提交记录自动生成');
  say('');
  say('生产环境升级：cd /root/firemail && docker compose pull && docker compose up -d');
}

// ---------------------------------------------------------------------------
// 前置校验：任何一条不满足都不该开始改文件
// ---------------------------------------------------------------------------

function requireCleanTree() {
  if (capture('git', ['status', '--porcelain']).trim()) {
    fail('工作区有未提交的改动。发版提交里只该有版本号，先把手上的东西提交或暂存掉。');
  }
}

function requireBranch(expected) {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== expected) {
    fail(`当前在 ${branch} 分支。发版要从 ${expected} 发，先 git checkout ${expected} && git pull。`);
  }
}

function requireTagIsNew(tag) {
  const existing = capture('git', ['tag', '-l', tag]).trim();
  if (existing) fail(`tag ${tag} 已经存在。正式版本号不重写——换一个版本号。`);
}

/** 版本号只能往前走：回退或原地不动的发版是最难排查的一类事故。 */
function requireForward(current, next) {
  const a = current.split('.').map(Number);
  const b = next.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return;
    if (b[i] < a[i]) fail(`${next} 比当前的 ${current} 还小，版本号只能往前走。`);
  }
  fail(`${next} 和当前版本一样，没有可发的东西。`);
}

// ---------------------------------------------------------------------------

/** 只替换第一处 "version": "x.y.z"，保持文件其余部分逐字节不变（缩进、键顺序都不动）。 */
function bumpManifest(path, version) {
  const file = fileURLToPath(new URL(path, ROOT));
  const raw = readFileSync(file, 'utf8');
  const next = raw.replace(/"version":\s*"\d+\.\d+\.\d+"/, `"version": "${version}"`);
  if (next === raw) fail(`${path} 里没找到可替换的 version 字段`);
  writeFileSync(file, next);
}

function bumpVersionSource(version) {
  const file = fileURLToPath(new URL(VERSION_SOURCE, ROOT));
  const raw = readFileSync(file, 'utf8');
  const next = raw.replace(/(export const VERSION = ')\d+\.\d+\.\d+(')/, `$1${version}$2`);
  if (next === raw) fail(`${VERSION_SOURCE} 里没找到 VERSION 常量`);
  writeFileSync(file, next);
}

function readJson(path) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8'));
}

const major = (v) => v.split('.')[0];
const minor = (v) => v.split('.')[1];

function run(command, args) {
  execFileSync(command, args, { cwd: fileURLToPath(ROOT), stdio: 'inherit' });
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`发版中止：${message}\n`);
  process.exit(1);
}

main();
