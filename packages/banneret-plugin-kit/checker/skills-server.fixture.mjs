import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { referenceSkills } from "../src/referenceSkills.fixture.ts";

export function skillsServer(broken) {
  const provider = referenceSkills();
  const server = new Server(
    { name: "fixture", version: "1" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["acme_skills_list", "acme_skills_get"].map((name) => ({
      name,
      inputSchema: { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await provider.callTool(params.name, params.arguments);
    return { content: [], ...result };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ name: "deploy", uri: "skill://deploy/" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) =>
    broken ? { contents: [] } : provider.readResource(params.uri),
  );
  return server;
}
if (import.meta.main)
  await skillsServer(process.argv.includes("broken")).connect(new StdioServerTransport());
