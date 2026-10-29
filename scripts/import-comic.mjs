// 扫描版（连环画/漫画）导入器：
//   epub 里的图片 → Windows OCR 识别 → 去掉汉字之间的多余空格 → 按页分组 → 落到书架目录。
//
// 为什么单独一个脚本：import-book.mjs 处理的是**有文字层**的电子书；这套《平凡的世界》
// 是连环画（244 张 jpg 合成的 epub），文字只能靠 OCR，而 OCR 有几个必须收拾的毛病：
//   1) 每个汉字之间被插入空格（"平 凡 的 世 界"）；
//   2) 图片文件名是 index-1_1 / index-10_1 / index-100_1，字典序 ≠ 页序，必须按数字排；
//   3) 纯图片页（无旁白）会产出空块，要跳过但保留页号。
//
// 用法：node import-comic.mjs <epub> <slug> "<标题>" [每章页数]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BOOKS_DIR = process.env.BOOKS_DIR || 'F:\\books';
const OCR_PS1 = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'ocr.ps1');

/** 汉字/中文标点之间的空格全部删掉；保留英文单词之间的空格。 */
function cleanCjk(text) {
  return String(text)
    // 汉字之间
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
    // 汉字与中文标点之间
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[，。、；：？！…—）》」』”’])/g, '$1')
    .replace(/([（《「『“‘])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
    // 单个汉字被空格隔开的多轮残留（OCR 有时混排）
    .replace(/([\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 逐行清洗：丢掉「纯画格编号」「符号乱码」这类碎片，保住真正的旁白。 */
function tidy(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]{2,}/g, ' ').trim();
    if (!line) continue;
    const cjk = (line.match(/[\u4e00-\u9fff]/g) || []).length;
    const hasCaptionNumber = /^\d+\s*[．.、]/.test(line);
    const endsLikeProse = /[。！？”’…]$/.test(line);
    // 单独的画格编号（"54"）是噪音——真正的编号在旁白开头已经带着了
    if (/^[\d\s．.、·]+$/.test(line)) continue;
    // 只留「像一整句话」的行：汉字够多，或汉字一般多但以句末标点收尾。
    // 这样 "1 咝骤"、"@巛壹．一后"、"产 0 宀，" 这类画格旁的碎片会被清掉，而旁白保留。
    if (cjk >= 6) { out.push(line); continue; }
    if (cjk >= 3 && endsLikeProse) { out.push(line); continue; }
    if (hasCaptionNumber && cjk >= 3) { out.push(line); continue; }
  }
  return out.join('\n');
}

/** index-12_3.jpg -> [12, 3]，按数字自然排序（字典序会把 10 排到 2 前面）。 */
function pageOrder(name) {
  const m = /index-(\d+)_(\d+)/i.exec(name) || /(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2] ?? 0), name] : [Number.MAX_SAFE_INTEGER, 0, name];
}

function unzip(epub, dest) {
  execFileSync('tar', ['-xf', epub, '-C', dest], { stdio: 'pipe' });
}

function main() {
  const [epub, slugArg, titleArg, pagesArg] = process.argv.slice(2);
  if (!epub || !slugArg) {
    console.error('用法: node import-comic.mjs <epub> <slug> "<标题>" [每章页数]');
    process.exit(1);
  }
  const slug = String(slugArg).toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(slug)) {
    console.error('slug 只能用小写字母/数字/-/_');
    process.exit(1);
  }
  const title = titleArg || path.basename(epub, path.extname(epub));
  const pagesPerChapter = Math.max(5, Number(pagesArg) || 20);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-'));
  const raw = path.join(work, 'raw');
  const pages = path.join(work, 'pages');
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(pages, { recursive: true });

  console.log(`[1/3] 解包 ${path.basename(epub)}`);
  unzip(epub, raw);

  // 收集所有页面图片并按自然页序重命名成 0001.jpg ...（OCR 脚本按文件名排序）
  const imgs = fs.readdirSync(raw).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort((a, b) => {
    const [na, sa] = pageOrder(a);
    const [nb, sb] = pageOrder(b);
    return na - nb || sa - sb || a.localeCompare(b);
  });
  if (!imgs.length) {
    console.error('epub 里没有图片，这不是扫描版？');
    process.exit(2);
  }
  imgs.forEach((name, i) => {
    fs.copyFileSync(path.join(raw, name), path.join(pages, String(i + 1).padStart(4, '0') + path.extname(name).toLowerCase()));
  });
  console.log(`      共 ${imgs.length} 页`);

  console.log('[2/3] OCR（Windows 自带中文引擎）');
  const ocrOut = path.join(work, 'ocr.txt');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-Dir', pages, '-Out', ocrOut], { stdio: 'inherit' });

  console.log('[3/3] 清理并写入书架');
  const rawOcr = fs.readFileSync(ocrOut, 'utf8');
  const blocks = [...rawOcr.matchAll(/<!-- page ([^\s]+?)(?: FAILED: [^>]*)? -->\r?\n([\s\S]*?)(?=<!-- page |\s*$)/g)];
  const pageTexts = [];
  for (const b of blocks) {
    const pno = Number((/(\d+)/.exec(b[1]) || [0, 0])[1]);
    const text = tidy(cleanCjk(b[2] || ''));
    pageTexts.push({ page: pno, text });
  }
  const withText = pageTexts.filter((p) => p.text.replace(/\s/g, '').length >= 4);
  console.log(`      识别到文字的页：${withText.length}/${pageTexts.length}`);

  const outDir = path.join(BOOKS_DIR, slug);
  fs.mkdirSync(path.join(outDir, 'chapters'), { recursive: true });

  const index = {
    slug,
    title,
    sourceFile: epub,
    format: 'comic-ocr',
    importedAt: new Date().toISOString(),
    pages: pageTexts.length,
    chapters: []
  };
  let total = 0;
  let n = 0;
  for (let i = 0; i < pageTexts.length; i += pagesPerChapter) {
    const slice = pageTexts.slice(i, i + pagesPerChapter);
    const first = slice[0].page;
    const last = slice[slice.length - 1].page;
    const chunkTitle = `第 ${first}–${last} 页`;
    const body = slice
      .filter((p) => p.text)
      .map((p) => `（第 ${p.page} 页）\n${p.text}`)
      .join('\n\n');
    if (!body.trim()) continue;
    n++;
    const name = String(n).padStart(4, '0') + '.txt';
    fs.writeFileSync(path.join(outDir, 'chapters', name), `${chunkTitle}\n\n${body}\n`, 'utf8');
    total += body.length;
    index.chapters.push({ n, title: chunkTitle, chars: body.length, file: name });
  }
  index.chars = total;
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`✅ 《${title}》 ${pageTexts.length} 页 / ${index.chapters.length} 段 / ${total} 字`);
  console.log(`   slug: ${slug}`);
}

main();
