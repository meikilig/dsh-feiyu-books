// 安装脚本：把书架接进 DSH。
//
// 它做四件事，全部幂等（重复跑不会把配置改乱）：
//   1. 把 cordis.patch.yml 里的占位符换成本机绝对路径（node 路径 + server.mjs 路径）；
//   2. 在 profile 的 package.json 里注册依赖（link: 到本包目录）与 bundle；
//   3. 摘掉 profile 的 cordis.patch.yml 里**旧的** mcp-books 条目（如果之前手工加过），
//      否则同一个 serverName 会注册两次；
//   4. 打印下一步（安装依赖、重启 DSH）。
//
// 用法：
//   node scripts/install.mjs                 # 装进默认 profile（desktop）
//   node scripts/install.mjs --profile web   # 指定 profile
//   node scripts/install.mjs --dry-run       # 只看会改什么，不落盘
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const SERVER = path.join(PKG_DIR, 'server.mjs');
const PATCH = path.join(PKG_DIR, 'cordis.patch.yml');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const profileArg = (() => {
  const i = argv.indexOf('--profile');
  return i >= 0 ? argv[i + 1] : '';
})();
const PROFILE = profileArg || process.env.DSH_PROFILE || 'desktop';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);

function log(msg) { console.log(msg); }
function fail(msg) { console.error('❌ ' + msg); process.exitCode = 1; }

if (!fs.existsSync(PROFILE_DIR)) {
  fail(`找不到 profile 目录：${PROFILE_DIR}\n   如果 DSH 安装位置不同，请先设置环境变量 DSH_HOME。`);
  process.exit(1);
}

// ── 1. 填 patch ───────────────────────────────────────────────
const patchText = `# 书架 MCP 注册（由 scripts/install.mjs 生成，勿手工改）
- insert:
    - id: mcp-books
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: books
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(SERVER)}
`;
log(`[1/4] 写 cordis.patch.yml → ${process.execPath}`);
log(`      server: ${SERVER}`);
if (!dryRun) fs.writeFileSync(PATCH, patchText, 'utf8');

// ── 2. 注册 bundle ───────────────────────────────────────────
const profilePkgPath = path.join(PROFILE_DIR, 'package.json');
let profilePkg;
try {
  profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
} catch (error) {
  fail(`读不了 ${profilePkgPath}：${error.message}`);
  process.exit(1);
}
profilePkg.dependencies = profilePkg.dependencies && typeof profilePkg.dependencies === 'object' ? profilePkg.dependencies : {};
profilePkg.dsh = profilePkg.dsh && typeof profilePkg.dsh === 'object' ? profilePkg.dsh : {};
profilePkg.dsh.profile = profilePkg.dsh.profile && typeof profilePkg.dsh.profile === 'object' ? profilePkg.dsh.profile : {};
const bundles = Array.isArray(profilePkg.dsh.profile.bundles) ? profilePkg.dsh.profile.bundles : [];
const hadBundle = bundles.includes('dsh-books');
if (!hadBundle) bundles.push('dsh-books');
profilePkg.dsh.profile.bundles = bundles;
// 注意：不再写 link: 依赖 —— 有些机器（含本机）不允许在 node_modules 里创建
// junction/symlink（Access denied），而 npm/pnpm 自己也未必能建。改成直接把包
// 复制进 profile 的 node_modules（见第 3 步），这样不依赖重解析点。
delete profilePkg.dependencies['dsh-books'];

log(`[2/4] profile bundles：${hadBundle ? '已包含 dsh-books' : '新增 dsh-books'}`);
if (!dryRun) fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8');

// ── 3. 把包装进 profile/node_modules ─────────────────────────
// 只复制 DSH 装载需要的三样（package.json / index.js / cordis.patch.yml）；
// server.mjs 由 cordis.patch.yml 里的**绝对路径**直接指向源目录，所以源目录
// 更新代码后不需要重新复制（除非改了 patch 本身）。
const NM_DIR = path.join(PROFILE_DIR, 'node_modules', 'dsh-books');
const COPY_FILES = ['package.json', 'index.js', 'cordis.patch.yml'];
log(`[3/4] 复制插件到 ${NM_DIR}`);
if (!dryRun) {
  try {
    fs.mkdirSync(NM_DIR, { recursive: true });
    for (const f of COPY_FILES) {
      fs.copyFileSync(path.join(PKG_DIR, f), path.join(NM_DIR, f));
    }
  } catch (error) {
    log(`      ⚠️ 复制失败：${error.message}`);
    log('      可以手工把 package.json / index.js / cordis.patch.yml 复制到上面那个目录。');
  }
}

// ── 4. 清掉旧的 mcp-books 条目（SurfCore 托管块里可能有一份）────
const profilePatch = path.join(PROFILE_DIR, 'cordis.patch.yml');
if (fs.existsSync(profilePatch)) {
  const original = fs.readFileSync(profilePatch, 'utf8');
  // 只删「以 - insert: 开头、内部含 id: mcp-books」的那一块，其它条目原样保留。
  const blocks = original.split(/^(?=- insert:)/m);
  const kept = blocks.filter((b) => !/id:\s*mcp-books\b/.test(b));
  const removed = blocks.length - kept.length;
  if (removed > 0) {
    log(`[4/4] 从 profile patch 里移除 ${removed} 个旧 mcp-books 条目（避免重复注册）`);
    if (!dryRun) fs.writeFileSync(profilePatch, kept.join(''), 'utf8');
  } else {
    log('[4/4] profile patch 里没有旧 mcp-books 条目，跳过');
  }
} else {
  log('[4/4] profile 没有 cordis.patch.yml，跳过');
}

// ── 依赖检查 ─────────────────────────────────────────────────
const needDeps = ['@modelcontextprotocol/sdk', 'zod'];
const missing = needDeps.filter((d) => {
  try { return !fs.existsSync(path.join(PKG_DIR, 'node_modules', ...d.split('/'), 'package.json')); } catch { return true; }
});

log('');
log('────────────────────────────────────────────');
if (missing.length) {
  log(`下一步：先装依赖（缺 ${missing.join(', ')}）`);
  log(`  cd "${PKG_DIR}"`);
  log('  npm install --omit=dev');
} else {
  log('依赖已就绪。');
}
log('');
log('然后重启一次 DSH，书架工具就会以 mcp__books__* 出现。');
log('验证：让她说一句"书架里有什么书"，或看 DSH 日志里有没有 [dsh-books] 装载行。');
log('────────────────────────────────────────────');
