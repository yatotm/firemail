import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { VERSION } from './routes/health.ts';

/**
 * 版本号在这个仓库里写在 6 个地方，它们必须永远一致。
 *
 * 为什么不做成「一处定义、其余引用」：服务端的 `VERSION` 要在编译产物里可用，
 * 从 package.json 读就得把它一起拷进镜像并开 resolveJsonModule；而 pnpm workspace
 * 的各个 package.json 本来就得各写各的版本号（发布工具、依赖解析都认它）。
 * 与其为了消灭重复引入运行期耦合，不如让重复**可检测**——漏改一处这条就红。
 *
 * 改版本号用 `pnpm release <版本号>`，它会一次改完这 6 处。
 */

const ROOT = new URL('../../../', import.meta.url);

/** 与 tools/release.mjs 里的清单同源，改一处要改两处——所以这条用例也盯着它。 */
const MANIFESTS = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
  'tools/migrate-legacy/package.json',
];

function versionOf(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(relativePath, ROOT)), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

test('所有 package.json 的版本号一致', () => {
  const versions = MANIFESTS.map((path) => [path, versionOf(path)] as const);
  const [, expected] = versions[0] as readonly [string, string];

  for (const [path, version] of versions) {
    assert.equal(version, expected, `${path} 的版本号与根 package.json 不一致`);
  }
});

test('/api/health 返回的版本号与 package.json 一致', () => {
  assert.equal(
    VERSION,
    versionOf('package.json'),
    'apps/server/src/routes/health.ts 里的 VERSION 漏改了；用 pnpm release <版本号> 改',
  );
});

test('版本号是合法的语义化版本', () => {
  assert.match(versionOf('package.json'), /^\d+\.\d+\.\d+$/);
});
