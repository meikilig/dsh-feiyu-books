// 书架 MCP 的自测：真起一个 stdio 客户端，把四个工具都调一遍。
//
// 用法：node scripts/selftest.mjs [booksDir]
// 它会自己找到同包下的 server.mjs，不依赖任何绝对路径。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const booksDir = process.argv[2] || undefined;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, ...(booksDir ? { BOOKS_DIR: booksDir } : {}) }
});
const client = new Client({ name: 'books-selftest', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('工具:', tools.tools.map((t) => t.name).join(', '));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? JSON.stringify(r);
  console.log(`\n--- ${name}(${JSON.stringify(args)}) ---`);
  console.log(text.slice(0, 400));
  return text;
};

const list = await call('books_list');
if (!/空/.test(list)) {
  const slug = /- ([a-z0-9_-]+)｜/.exec(list)?.[1];
  if (slug) {
    await call('books_toc', { book: slug });
    await call('books_read', { book: slug, chapter: 1, maxChars: 300 });
  }
}
// 越界必须被拒
await call('books_read', { book: '../etc', chapter: 1 });

await client.close();
