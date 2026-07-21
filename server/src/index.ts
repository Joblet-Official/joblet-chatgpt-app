import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health endpoint
app.get("/", (req, res) => res.json({ name: "Joblet ChatGPT App", status: "running", mcp: "/mcp" }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "joblet-chatgpt-app", version: "2.0.0" }));

// OpenAI domain verification
app.get("/.well-known/openai-apps-challenge", (req, res) => {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (!token) return res.status(404).send("Not configured");
  res.type("text/plain").send(token);
});

const WIDGET_URI = "ui://joblet/job-cards";

// Create a fresh McpServer per connection (stateless)
function buildMcpServer() {
  const server = new McpServer(
    { name: "Joblet - AI Job Search", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // Register the UI widget as a resource
  server.resource(
    "joblet-job-cards",
    WIDGET_URI,
    { name: "Joblet Job Cards", mimeType: "text/html" },
    async (uri) => {
      const widgetPath = path.join(__dirname, '..', 'public', 'widget', 'job-cards.html');
      let html: string;
      try { html = fs.readFileSync(widgetPath, 'utf-8'); }
      catch { html = "<html><body><p>Widget not found</p></body></html>"; }
      return { contents: [{ uri: uri.href, mimeType: "text/html", text: html }] };
    }
  );

  // Register the search_jobs tool
  server.tool(
    "search_jobs",
    "Search current Joblet jobs and side gigs by title, location, remote preference, employment type, salary, and schedule.",
    {
      query: z.string().describe("Job title, skill, or keyword"),
      location: z.string().optional().describe("City, state or 'remote'"),
      radius_miles: z.number().min(1).max(100).optional(),
      remote: z.boolean().optional(),
      employment_types: z.array(z.string()).optional(),
      salary_min: z.number().optional(),
      limit: z.number().min(1).max(20).optional().default(12)
    },
    async (args) => {
      try {
        const response = await fetch("https://joblet.ai/api/chatgpt/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args)
        });

        if (!response.ok) throw new Error(`Joblet API error: ${response.status}`);
        const data = await response.json();

        return {
          content: [{ type: "text" as const, text: `Found ${data.total || 0} Joblet opportunities.` }],
          structuredContent: data,
          _meta: { ui: { resourceUri: WIDGET_URI } }
        } as any;

      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }]
        };
      }
    }
  );

  return server;
}

// Main /mcp endpoint using StreamableHTTP (what ChatGPT's validator expects)
app.all("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // stateless mode
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => server.close().catch(console.error));
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Legacy /sse endpoint kept for backwards compatibility
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sseTransports = new Map<string, SSEServerTransport>();

function buildLegacyServer() {
  const server = new Server(
    { name: "Joblet - AI Job Search", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: WIDGET_URI, name: "Joblet Job Cards", mimeType: "text/html" }]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const widgetPath = path.join(__dirname, '..', 'public', 'widget', 'job-cards.html');
    let html: string;
    try { html = fs.readFileSync(widgetPath, 'utf-8'); }
    catch { html = "<html><body>Widget not found</body></html>"; }
    return { contents: [{ uri: req.params.uri, mimeType: "text/html", text: html }] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "search_jobs",
      description: "Search current Joblet jobs by title, location, remote preference, salary, and schedule.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          location: { type: "string" },
          limit: { type: "number", default: 12 }
        },
        required: ["query"]
      },
      _meta: { ui: { resourceUri: WIDGET_URI } }
    }]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search_jobs") {
      try {
        const response = await fetch("https://joblet.ai/api/chatgpt/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.params.arguments)
        });
        const data = await response.json();
        return {
          content: [{ type: "text", text: `Found ${data.total || 0} opportunities.` }],
          structuredContent: data,
          _meta: { ui: { resourceUri: WIDGET_URI } }
        } as any;
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    }
    throw new Error("Tool not found");
  });

  return server;
}

app.get("/sse", async (req, res) => {
  const server = buildLegacyServer();
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
  sseTransports.set(transport.sessionId, transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) { res.status(400).send("No session: " + sessionId); return; }
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Joblet MCP Server v2.0.0 running on http://localhost:${PORT}`);
});
