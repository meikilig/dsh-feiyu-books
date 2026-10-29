// 书架 MCP server（stdio）：让 QQ 里的人格按章读电子书。
//
// 设计边界（和本项目其它 MCP 一致的"最小能力"原则）：
//   · 只读，绝不写文件、不列目录外的路径；
//   · 书名只接受 [a-z0-9_-]，且最终路径必须落在 BOOKS_DIR 里（双保险防穿越）；
//   · 单次返回有字数上限（默认 6000，硬顶 12000），避免一次把整本书塞进上下文；
//   · 书必须先由 scripts/import-book.mjs 拆成「一章一个 txt」，本服务只做纯文本读取。
//
// 配置（全部可选，缺省就能跑）：
//   ~/.dsh/books/config.json  { "enabled": true, "booksDir": "F:\\books" }
//   环境变量 BOOKS_CONFIG / BOOKS_DIR 优先于上面的文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认配置目录：和 DSH 的其它插件保持一致，放 ~/.dsh/books/ 下。 */
const CONFIG_PATH = process.env.BOOKS_CONFIG
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'books', 'config.json');

function readUserConfig() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const j = JSON.parse(text);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

const USER_CFG = readUserConfig();
const BOOKS_DIR = path.resolve(String(process.env.BOOKS_DIR || USER_CFG.booksDir || path.join(os.homedir(), '.dsh', 'books', 'library')));

const DEFAULT_MAX_CHARS = 6000;
const HARD_MAX_CHARS = 12000;
const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

const server = new McpServer({ name: 'books', version: '1.0.0' });

/**
 * 总开关：config 的 `enabled`（缺省 = 开）。
 *
 * 为什么需要它：MCP 的工具清单会随**每一次**模型请求一起下发，4 个工具约 1.9 KB
 * （≈600 token）。不读书的日子里这就是白花的上下文和钱。关掉时本服务照常启动，
 * 但只保留一个几十字节的状态工具 —— mcp__books__* 那 1.9 KB 归零。
 *
 * 注意：开关在 **MCP 服务启动时**读一次；改完要重启 DSH（或让 QQ 会话重建）才生效。
 */
const ENABLED = USER_CFG.enabled !== false;
if (!ENABLED) {
  process.stderr.write(`[books] 已关闭（${CONFIG_PATH} 里 enabled=false），本次只保留一个状态工具\n`);
  // 不能"一个工具都不注册"：McpServer 零工具时不会声明 tools 能力，客户端拿到
  // -32601 Method not found（实测），宿主会当成协议异常记一条错。
  // 留一个几十字节的状态工具，既避免协议噪音，又几乎不占上下文。
  server.tool(
    'books_status',
    '书架当前处于关闭状态（管理员在书架配置里关了 enabled）。不要尝试读书，也不要催管理员打开。',
    {},
    async () => ({
      content: [{ type: 'text', text: `书架已关闭。需要读书请让管理员把 ${CONFIG_PATH} 的 enabled 改成 true，并重启 DSH 一次。` }]
    })
  );
}

/** 关掉时让注册变成空操作，而不是在每个工具里各写一遍 if。 */
function tool(...args) {
  if (!ENABLED) return;
  server.tool(...args);
}


function bookDir(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new Error(`书名不合法：「${slug}」。只能用小写字母/数字/-/_（导入时会打印 slug）`);
  const dir = path.resolve(BOOKS_DIR, s);
  if (!dir.startsWith(BOOKS_DIR + path.sep)) throw new Error('拒绝越界访问');
  if (!fs.existsSync(path.join(dir, 'index.json'))) throw new Error(`没有这本书：${s}（先让管理员导入）`);
  return dir;
}

function loadIndex(slug) {
  const dir = bookDir(slug);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return { dir, index };
}

function clip(text, maxChars) {
  const cap = Math.min(Math.max(200, Number(maxChars) || DEFAULT_MAX_CHARS), HARD_MAX_CHARS);
  if (text.length <= cap) return { text, truncated: false, cap };
  return { text: text.slice(0, cap), truncated: true, cap };
}

tool(
  'books_list',
  '列出书架上的书（书名 slug、标题、章数、字数）。想知道有哪些书可读时先调这个。',
  {},
  async () => {
    let entries = [];
    try {
      entries = fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => SLUG_RE.test(name) && fs.existsSync(path.join(BOOKS_DIR, name, 'index.json')));
    } catch {
      return { content: [{ type: 'text', text: `书架目录不可用（${BOOKS_DIR}）。请管理员先导入电子书。` }] };
    }
    if (!entries.length) {
      return { content: [{ type: 'text', text: '书架是空的。让管理员用 import-book.mjs 导入一本。' }] };
    }
    const lines = entries.map((slug) => {
      try {
        const idx = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, slug, 'index.json'), 'utf8'));
        return `- ${idx.slug}｜《${idx.title}》｜${idx.chapters.length} 章｜${idx.chars} 字`;
      } catch {
        return `- ${slug}（索引损坏）`;
      }
    });
    return { content: [{ type: 'text', text: `书架（${entries.length} 本）：\n${lines.join('\n')}` }] };
  }
);

tool(
  'books_toc',
  '看一本书的目录（章节标题与字数），用来决定读哪一章。',
  { book: z.string().describe('书名 slug，来自 books_list') },
  async ({ book }) => {
    try {
      const { index } = loadIndex(book);
      const lines = index.chapters.map((c) => `${String(c.n).padStart(3, ' ')}. ${c.title}（${c.chars} 字）`);
      return {
        content: [{
          type: 'text',
          text: `《${index.title}》共 ${index.chapters.length} 章：\n${lines.join('\n')}\n\n读某一章用 books_read(book="${index.slug}", chapter=N)。`
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `读目录失败：${error?.message ?? error}` }] };
    }
  }
);

tool(
  'books_read',
  '读一本书的某一章（或从某章起连续几章）。返回正文；超长会被截断并提示还有多少字。',
  {
    book: z.string().describe('书名 slug'),
    chapter: z.coerce.number().int().min(1).optional().describe('章号，从 1 开始；默认第 1 章'),
    count: z.coerce.number().int().min(1).max(3).optional().describe('连续读几章（默认 1，最多 3）'),
    maxChars: z.coerce.number().int().optional().describe('本次最多返回多少字（默认 6000，上限 12000）')
  },
  async ({ book, chapter, count, maxChars }) => {
    try {
      const { dir, index } = loadIndex(book);
      const start = Number(chapter) || 1;
      const n = Math.min(Number(count) || 1, 3);
      if (start > index.chapters.length) {
        return { content: [{ type: 'text', text: `这本书只有 ${index.chapters.length} 章，没有第 ${start} 章。` }] };
      }
      const want = index.chapters.slice(start - 1, start - 1 + n);
      let body = '';
      for (const c of want) {
        let text = fs.readFileSync(path.join(dir, 'chapters', c.file), 'utf8');
        // 章节文件的第一行是标题（导入时写进去的），这里去掉，免得和下面的抬头重复两遍。
        const firstBreak = text.indexOf('\n');
        if (firstBreak >= 0 && text.slice(0, firstBreak).trim() === c.title.trim()) {
          text = text.slice(firstBreak + 1).trim();
        }
        body += `\n\n===== 第 ${c.n} 章 · ${c.title} =====\n\n${text}`;
      }
      const { text, truncated, cap } = clip(body.trim(), maxChars);
      const rest = body.length - text.length;
      const tail = truncated
        ? `\n\n…（本次上限 ${cap} 字，后面还有约 ${rest} 字没给出；接着读下一段就用更大的 chapter 或分段读）`
        : '';
      return {
        content: [{
          type: 'text',
          text: `《${index.title}》第 ${start}${n > 1 ? `~${start + n - 1}` : ''} 章（共 ${index.chapters.length} 章）：\n${text}${tail}`
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `读章节失败：${error?.message ?? error}` }] };
    }
  }
);

tool(
  'books_search',
  '在整本书里搜一个词/句子，返回命中的章节号和上下文片段（最多 5 条）。',
  {
    book: z.string().describe('书名 slug'),
    query: z.string().min(1).describe('要找的词或句子'),
    limit: z.coerce.number().int().min(1).max(10).optional().describe('最多几条，默认 5')
  },
  async ({ book, query, limit }) => {
    try {
      const { dir, index } = loadIndex(book);
      const q = String(query).trim();
      const max = Number(limit) || 5;
      const hits = [];
      for (const c of index.chapters) {
        const text = fs.readFileSync(path.join(dir, 'chapters', c.file), 'utf8');
        let from = 0;
        while (hits.length < max) {
          const i = text.indexOf(q, from);
          if (i < 0) break;
          const s = Math.max(0, i - 60);
          const snippet = text.slice(s, i + q.length + 60).replace(/\s+/g, ' ');
          hits.push(`第 ${c.n} 章《${c.title}》…${snippet}…`);
          from = i + q.length;
        }
        if (hits.length >= max) break;
      }
      if (!hits.length) {
        return { content: [{ type: 'text', text: `《${index.title}》里没找到「${q}」。` }] };
      }
      return { content: [{ type: 'text', text: `《${index.title}》里找到 ${hits.length} 处「${q}」：\n${hits.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }] };
    }
  }
);

await server.connect(new StdioServerTransport());
