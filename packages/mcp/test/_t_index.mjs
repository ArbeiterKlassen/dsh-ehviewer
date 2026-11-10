import path from 'node:path';
import { fileURLToPath as _f } from 'node:url';
const dirname = path.dirname(_f(import.meta.url));
// 临时端到端校验：真的用 SDK 客户端跟 index.js 握手，走一遍 tools/list 与一次 tools/call。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(dirname, '../src/index.js')],
  stderr: 'pipe',
});
transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);
const info = client.getServerVersion();
console.log('server:', JSON.stringify(info));

const list = await client.listTools();
console.log('tools/list:', list.tools.length, '首个:', list.tools[0]?.name, '| desc len:', list.tools[0]?.description?.length);

const r1 = await client.callTool({ name: 'eh_download_status', arguments: {} });
console.log('call eh_download_status:', r1.content?.[0]?.text?.slice(0, 80));

const r2 = await client.callTool({ name: 'eh_search', arguments: { query: 'test' } });
console.log('call eh_search isError:', r2.isError, '|', r2.content?.[0]?.text?.slice(0, 90));

await client.close();
