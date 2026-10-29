// 电子书导入器：把 txt / md / epub 拆成「按章存储的纯文本」。
//
// 为什么先拆、而不是让 MCP 现读原文件：
//   1) epub 是 zip + xhtml，每次现解一遍既慢又容易出错；
//   2) 拆成「一章一个 txt」之后，MCP 那边只做纯文本读写，代码小、可测、不会路径穿越。
//
// 用法：node import-book.mjs <书文件路径> [slug]
// 产物：<BOOKS_DIR>/<slug>/{index.json, chapters/0001.txt ...}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BOOKS_DIR = process.env.BOOKS_DIR || 'F:\\books';
const MAX_CHAPTER_CHARS = 12000; // 单章上限，超了就按段落切开，避免一章几万字塞爆上下文

function slugify(input) {
  const ascii = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'book-' + Date.now().toString(36);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 章节标题识别：中文章节、Chapter N、Markdown 标题。 */
const HEADING_RE = /^\s*(第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷篇]|Chapter\s+\d+|序章|楔子|前言|后记|尾声|番外[^\n]{0,20}|#{1,3}\s+\S.{0,40})/i;

/** 把整本书的纯文本按标题切成章；没有标题就按长度切。 */
function splitChapters(text) {
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let current = { title: '正文', lines: [] };
  let sawHeading = false;

  for (const line of lines) {
    // 只有「短、且不带句末标点」的行才算章节标题。
    // 否则正文里一句「第二章的内容也在这里。」会被当成新章节标题，把章切碎。
    const trimmed = line.trim();
    if (HEADING_RE.test(line) && trimmed.length <= 30 && !/[。！？；!?;]/.test(trimmed)) {
      sawHeading = true;
      // 只要有内容就收下：早期版本这里卡了「> 200 字」，短章（诗、对话、番外）会被整章丢掉。
      if (current.lines.join('').trim().length > 0) chapters.push(current);
      current = { title: trimmed.replace(/^#{1,3}\s*/, ''), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.join('').trim().length > 0) chapters.push(current);

  if (!sawHeading) {
    // 没有章节标记：按段落聚合成 ~4000 字的块
    const paras = text.split(/\n{2,}/).filter((p) => p.trim());
    chapters.length = 0;
    let buf = '';
    let n = 0;
    for (const p of paras) {
      if (buf.length + p.length > 4000 && buf) {
        chapters.push({ title: `第 ${++n} 段`, lines: [buf] });
        buf = '';
      }
      buf += (buf ? '\n\n' : '') + p;
    }
    if (buf) chapters.push({ title: `第 ${++n} 段`, lines: [buf] });
  }

  // 单章过长再切（按段落），标题加 (1/2) 后缀
  const out = [];
  for (const c of chapters) {
    const body = c.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!body) continue;
    if (body.length <= MAX_CHAPTER_CHARS) {
      out.push({ title: c.title, text: body });
      continue;
    }
    const paras = body.split(/\n{2,}/);
    let buf = '';
    const parts = [];
    for (const p of paras) {
      if (buf.length + p.length > MAX_CHAPTER_CHARS && buf) {
        parts.push(buf);
        buf = '';
      }
      buf += (buf ? '\n\n' : '') + p;
    }
    if (buf) parts.push(buf);
    parts.forEach((part, i) => out.push({ title: `${c.title} (${i + 1}/${parts.length})`, text: part }));
  }
  return out;
}

function readEpub(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-'));
  // Windows 自带的 bsdtar 能直接解 zip（epub 就是 zip）
  execFileSync('tar', ['-xf', file, '-C', tmp], { stdio: 'pipe' });

  const containerPath = path.join(tmp, 'META-INF', 'container.xml');
  const container = fs.readFileSync(containerPath, 'utf8');
  const opfRel = /full-path="([^"]+)"/i.exec(container)?.[1];
  if (!opfRel) throw new Error('epub 里找不到 OPF（container.xml 没有 full-path）');

  const opfPath = path.join(tmp, ...opfRel.split('/'));
  const opfDir = path.dirname(opfPath);
  const opf = fs.readFileSync(opfPath, 'utf8');

  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/i.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    const type = /\bmedia-type="([^"]+)"/i.exec(tag)?.[1] || '';
    if (id && href) manifest.set(id, { href: decodeURIComponent(href), type });
  }

  const spineIds = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = /\bidref="([^"]+)"/i.exec(m[0])?.[1];
    if (idref) spineIds.push(idref);
  }

  const chapters = [];
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item) continue;
    if (!/x?html|xml/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue;
    const p = path.join(opfDir, ...item.href.split('/'));
    if (!fs.existsSync(p)) continue;
    const text = htmlToText(fs.readFileSync(p, 'utf8'));
    if (text.replace(/\s/g, '').length < 30) continue; // 封面/版权页之类
    const firstLine = text.split(/\n/).find((l) => l.trim()) ?? `第 ${chapters.length + 1} 章`;
    chapters.push({ title: firstLine.trim().slice(0, 50), text });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return chapters;
}

function readPlain(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return splitChapters(text);
}

function main() {
  const input = process.argv[2];
  const explicitSlug = process.argv[3];
  if (!input) {
    console.error('用法: node import-book.mjs <书文件路径> [slug]');
    process.exit(1);
  }
  const file = path.resolve(input);
  if (!fs.existsSync(file)) {
    console.error(`找不到文件: ${file}`);
    process.exit(1);
  }

  const ext = path.extname(file).toLowerCase();
  const baseName = path.basename(file, ext);
  const slug = slugify(explicitSlug || baseName);

  let chapters;
  if (ext === '.epub') chapters = readEpub(file);
  else if (['.txt', '.md', '.markdown', '.text'].includes(ext)) chapters = readPlain(file);
  else {
    console.error(`暂不支持 ${ext}（目前支持 .txt / .md / .epub）；PDF 请先转成 txt 或 epub。`);
    process.exit(2);
  }

  if (!chapters.length) {
    console.error('没切出任何章节，检查一下文件是不是空的/加密的。');
    process.exit(3);
  }

  const outDir = path.join(BOOKS_DIR, slug);
  fs.mkdirSync(path.join(outDir, 'chapters'), { recursive: true });

  const index = {
    slug,
    title: baseName,
    sourceFile: file,
    format: ext.replace('.', ''),
    importedAt: new Date().toISOString(),
    chapters: []
  };
  let total = 0;
  chapters.forEach((c, i) => {
    const n = i + 1;
    const name = String(n).padStart(4, '0') + '.txt';
    fs.writeFileSync(path.join(outDir, 'chapters', name), `${c.title}\n\n${c.text}\n`, 'utf8');
    total += c.text.length;
    index.chapters.push({ n, title: c.title, chars: c.text.length, file: name });
  });
  index.chars = total;
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log(`✅ ${baseName}`);
  console.log(`   共 ${chapters.length} 章 / ${total} 字`);
  console.log(`   目录：${outDir}`);
  console.log(`   slug：${slug}（让她读的时候用这个名字）`);
}

main();
