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
              "https://joblet-chatgpt-app.onrender.com",
              "https://joblet-chatgpt-app-n8yw.onrender.com"
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
      title: "Search Jobs",
      description: "Search live Joblet listings. CRITICAL RULES: 1. Pass the EXACT phrase the user typed into 'query' (do not add words like 'developer'). 2. If the user explicitly names a location, use it. 3. If the user does NOT name a location, you MUST infer their location from their profile/IP and append it to the query (e.g. 'manager in India'). 4. If any location search returns 0 jobs, you MUST immediately do a follow-up search completely empty of location to find global matches. 5. LOCATION-MISMATCH NOTE: ALWAYS show the job cards first and never hide or change them. Then check how many of the returned jobs actually match the location the user asked for. If the user named a COUNTRY and at least 8 of 10 jobs (about 80%) are outside that country, OR the user named a CITY and more than 6 of 10 jobs (about 60%) are outside that city, add a SHORT text note AFTER the cards: \"I couldn't find many exact matches in {location}, but here are related {role} roles you may like.\" If only a few jobs are off-location, add no note. Never add this note when the user did not specify a location.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The EXACT job title or keyword the user typed, plus the inferred or explicit location." },
          limit: { type: "number", default: 10 }
        },
        required: ["query"]
      },
      outputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          data: {
            type: "object",
            properties: {
              appliedFilters: { type: "object" },
              totalResults: { type: "number" },
              jobs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    company: { type: "string" },
                    location: { type: "string" },
                    salary: { type: ["string", "number", "null"] },
                    type: { type: "string" },
                    summary: { type: "string" },
                    url: { type: "string" },
                    jobletUrl: { type: "string" }
                  },
                  required: ["title", "url"]
                }
              }
            },
            required: ["jobs"]
          }
        },
        required: ["type", "data"]
      },
      annotations: {
        title: "Search Jobs",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
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

      // Timeout so a slow/hung Joblet API can't hang the ChatGPT tool call
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let response: Response;
      try {
        response = await fetch(`https://joblet.ai/api/search?${params.toString()}`, {
          headers: { "Accept": "application/json" },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

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
      // Log server-side, but never leak internal error details to the client
      console.error("search_jobs error:", error);
      return {
        isError: true,
        content: [{ type: "text", text: "Sorry, Joblet job search is temporarily unavailable. Please try again in a moment." }]
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
