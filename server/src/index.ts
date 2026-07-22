import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: '*',
  exposedHeaders: ['mcp-session-id'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Accept']
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Phase 4: Production Routes
app.get("/", (req, res) => res.json({ name: "Joblet ChatGPT App", status: "running", mcp: "/mcp" }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "joblet-chatgpt-app", version: "2.0.0" }));

app.get("/.well-known/openai-apps-challenge", (req, res) => {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (!token) {
    return res.status(404).send("Not configured");
  }
  res.type("text/plain").send(token);
});

const WIDGET_URI = "ui://joblet/job-cards-v1.html";

// Create a fresh McpServer per connection
function buildMcpServer() {
  const server = new Server(
    { name: "Joblet - AI Job Search", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: WIDGET_URI,
      name: "Joblet Job Cards",
      mimeType: "text/html;profile=mcp-app"
    }]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const widgetPath = path.join(__dirname, '..', 'public', 'widget', 'job-cards.html');
    let html: string;
    try { html = fs.readFileSync(widgetPath, 'utf-8'); }
    catch { html = "<html><body><p>Widget not found</p></body></html>"; }
    return {
      contents: [{ uri: req.params.uri, mimeType: "text/html;profile=mcp-app", text: html }],
      _meta: {
        ui: {
          domain: "https://joblet.ai",
          prefersBorder: true,
          csp: {
            connectDomains: [],
            resourceDomains: [
              "https://joblet.ai",
              "https://mcp.joblet.ai",
              "https://joblet-chatgpt-app.onrender.com"
            ],
            frameDomains: []
          }
        },
        "openai/widgetDescription": "Displays matching Joblet jobs in an interactive job-card carousel."
      }
    } as any;
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "search_jobs",
      description: "Search live Joblet listings and display interactive job cards. Use for initial job searches and follow-up refinements, including changes to title, location, salary, remote preference, employment type or pagination. CRITICAL: If you infer the user's location automatically and the search returns 0 jobs, you MUST immediately perform a second follow-up search with the location parameter completely empty to find global matches. Explain to the user that there were no local jobs, but show the global jobs.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The job title, keyword, and location (e.g. 'backend developer in India')" },
          remote: { type: "boolean" },
          minimumSalary: { type: "number" },
          employmentType: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "number", default: 10 }
        },
        required: ["query"]
      },
      _meta: {
        ui: {
          resourceUri: WIDGET_URI
        }
      }
    } as any]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "search_jobs") throw new Error("Tool not found");
    const args = request.params.arguments as any;
    
    try {
      const params = new URLSearchParams();
      // If ChatGPT hallucinates the old location param, append it to the query naturally
      const finalQuery = args.location ? `${args.query} in ${args.location}` : args.query;
      params.set("q", finalQuery);
      
      if (args.limit) params.set("limit", String(Math.min(Number(args.limit), 12)));
      else params.set("limit", "10");
      if (args.remote) params.set("remote", "true");

      const response = await fetch(`https://joblet.ai/api/search?${params.toString()}`, {
        headers: { "Accept": "application/json" }
      });

      if (!response.ok) throw new Error(`Joblet API error: ${response.status}`);
      const raw = await response.json();
      const apiData = raw.data || raw;

      const jobs = (apiData.jobs || []).map((j: any) => ({
        id: j.id || Math.random().toString(),
        title: j.title,
        company: j.company?.name || "",
        location: j.location || "Remote",
        salary: j.salary || null,
        type: (j.workSchedule?.[0] || j.employmentType?.[0] || "Full-time"),
        summary: j.summary || "",
        url: j.applyUrl || `https://joblet.ai`,
        jobletUrl: j.slug ? `https://joblet.ai/jobs/${j.slug}` : (j.applyUrl || `https://joblet.ai`)
      }));

      return {
        content: [{ type: "text", text: `Found ${apiData.total || jobs.length} Joblet opportunities.` }],
        structuredContent: {
          type: "application/json",
          data: {
            appliedFilters: args,
            totalResults: apiData.total || jobs.length,
            nextCursor: null,
            jobs: jobs
          }
        },
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false
        },
        _meta: {
          ui: {
            resourceUri: WIDGET_URI
          }
        }
      } as any;
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }]
      };
    }
  });

  return server;
}

// ----------------------------------------------------
// Streamable HTTP /mcp Transport (No express.json!)
// ----------------------------------------------------
app.all("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    
    // Pass raw req instead of req.body so transport can consume the stream natively
    await transport.handleRequest(req, res);
    
    res.on('close', () => server.close().catch(console.error));
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ----------------------------------------------------
// Legacy SSE Transport Fallback
// ----------------------------------------------------
const sseTransports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req, res) => {
  const server = buildMcpServer();
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
  sseTransports.set(transport.sessionId, transport);
});

// For /messages, we DO need express.json() if the SDK's handlePostMessage expects parsed body
app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) { res.status(400).send("No session: " + sessionId); return; }
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Joblet MCP Server v2.0.0 running on http://localhost:${PORT}`);
});
