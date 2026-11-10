// MCP 端到端探针：真的起一个 stdio server，走一遍 tools/list 与几个工具调用。
// 用法：node test/_t_mcp.mjs [toolName ...]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/index.js'],
  env: { ...process.env },
  stderr: 'pipe',
});

const client = new Client({ name: 'eh-mcp-probe', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.length);
console.log(tools.map((t) => t.name).join(' '));

const calls = process.argv.slice(2);
for (const raw of calls) {
  const [name, json] = raw.split('::');
  const args = json ? JSON.parse(json) : {};
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content || []).map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('\n');
  console.log(`\n=== ${name} (${Date.now() - t0}ms) isError=${!!res.isError}`);
  console.log(text.slice(0, 900));
}

await client.close();
