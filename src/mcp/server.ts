import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS, dispatchToolCall } from './tools.js';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'agentrelay',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Expose list of tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_SCHEMAS,
    };
  });

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatchToolCall(name, (args as Record<string, any>) ?? {});
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool "${name}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function runStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agentRelay MCP] Server connected via StdioServerTransport');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStdioServer().catch((err) => {
    console.error('[agentRelay MCP] Fatal error:', err);
    process.exit(1);
  });
}
