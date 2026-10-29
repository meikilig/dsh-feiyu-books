# dsh-books

给 [DeepSeek Harness](https://github.com/anywhere-labs) agent 的**只读书架**：把电子书拆成「一章一个 txt」，agent 就能按章阅读、按词检索，而不是把整本书塞进上下文。

> A read-only bookshelf MCP server for DSH agents. Chapter-by-chapter reading with hard caps, full-text search, and a kill switch.

## 它能做什么

| 工具 | 作用 |
|---|---|
| `books_list` | 列出书架上的书（书名 slug、章数、字数） |
| `books_toc` | 看某本书的目录（章节标题 + 每章字数） |
| `books_read` | 读某一章（可连续读 3 章；单次最多 12000 字，默认 6000） |
| `books_search` | 全书搜词，返回命中的章节与上下文片段 |
| `books_status` | 书架被关闭时唯一保留的工具，用来告诉 agent「别试了」 |

## 安全边界（有意做窄）

- **只读**：不写文件、不改书、不列书架目录之外的任何路径；
- **书名白名单**：只接受 `[a-z0-9_-]`，且最终路径必须落在书架目录内（防目录穿越）；
- **长度上限**：单次返回默认 6000 字、硬顶 12000 字，防止一本书把上下文撑爆；
- **不需要任何网络**：纯本地文件读取。

## 安装

```bash
git clone <repo> dsh-books
cd dsh-books
npm install --omit=dev          # 只有两个依赖：MCP SDK 与 zod
node scripts/install.mjs        # 写入本机绝对路径 + 注册到 profile
```

`install.mjs` 做的事（幂等，可以重复跑）：

1. 把 `cordis.patch.yml` 里的 `__NODE__` / `__SERVER__` 占位符换成本机绝对路径；
2. 在 `~/.dsh/profiles/<profile>/package.json` 里加上 `dsh-books` 依赖（`link:`）与 bundle；
3. 摘掉 profile patch 里**旧的** `mcp-books` 条目（避免同一个 server 注册两次）。

指定别的 profile：

```bash
node scripts/install.mjs --profile web
# 或先设环境变量
DSH_HOME=/path/to/.dsh DSH_PROFILE=web node scripts/install.mjs
```

只看会改什么、不落盘：

```bash
node scripts/install.mjs --dry-run
```

装完**重启一次 DSH**，工具会以 `mcp__books__*` 出现。

## 配置

配置文件（可选，缺省也能跑）：

```
~/.dsh/books/config.json
```

```json
{
  "enabled": true,
  "booksDir": "F:\\books"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。设成 `false` 后只保留 `books_status`，其余 4 个工具**不再注册**（省掉每次请求约 1.9 KB 的 schema） |
| `booksDir` | `~/.dsh/books/library` | 书放在哪 |

也可以用环境变量覆盖：`BOOKS_CONFIG`（配置文件路径）、`BOOKS_DIR`（书架目录）。

> 开关在 **MCP 服务启动时**读一次，改完要重启 DSH。

## 导入一本书

### 文字版（txt / md / epub）

```bash
node scripts/import-book.mjs "D:\\书\\草房子.epub"
node scripts/import-book.mjs "D:\\书\\some.txt" my-slug
```

产物：

```
<booksDir>/<slug>/
  index.json           # 标题、章数、每章字数
  chapters/0001.txt    # 一章一个文件
  chapters/0002.txt
```

### 扫描版（连环画 / 漫画 epub，只有图片没有文字层）

需要 Windows 自带的 OCR 语言包（`Language.OCR~~~zh-CN`，设置 → 语言里可装）：

```bash
node scripts/import-comic.mjs "D:\\书\\平凡的世界（上）.epub" pingfan-1 "平凡的世界·连环画（上）" 20
#                                                              ^slug      ^标题               ^每段页数
```

它会：解包 → 按页序重命名（`index-10` 不会排到 `index-2` 前面）→ OCR → 去掉汉字之间的多余空格 → 清洗画格编号碎片 → 按 20 页一段落盘。

## 自测

```bash
node scripts/selftest.mjs
```

真起一个 stdio 客户端，把 4 个工具都调一遍，并验证 `../etc` 这类越界书名会被拒绝。

## 卸载

1. 从 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里删掉 `dsh-books`；
2. 删掉 `cordis.patch.yml` 里 `id: mcp-books` 的 `- insert:` 块；
3. 重启 DSH。

书架目录（`booksDir`）不会被删——那是你的书。

## 已知限制

- **不支持 PDF**：PDF 抽文本要额外的解析器，扫描版 PDF 还得先 OCR 成图片。目前请先转成 txt/epub。
- **OCR 质量取决于原图**：密排小字（版权页、内容提要）容易糊；正文旁白一般可读。
- **一本书不会一次读完**：`books_read` 有字数上限，长书必须按章读——这是有意的设计。

## License

MIT
