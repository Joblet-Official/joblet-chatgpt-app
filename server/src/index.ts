import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

app.get("/", (req, res) => {
  res.status(200).json({ name: "Joblet ChatGPT App", status: "running", mcp: "/mcp" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "joblet-chatgpt-app", version: "1.2.0" });
});

app.get("/.well-known/openai-apps-challenge", (req, res) => {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (!token) return res.status(404).send("Not configured");
  res.type("text/plain").send(token);
});

const searchJobsSchema = z.object({
  query: z.string(),
  location: z.string().optional(),
  radius_miles: z.number().min(1).max(100).optional(),
  remote: z.boolean().optional(),
  employment_types: z.array(z.string()).optional(),
  salary_min: z.number().optional(),
  limit: z.number().min(1).max(20).default(12)
});

const transports = new Map<string, SSEServerTransport>();

// The UI resource URI we advertise to ChatGPT
const WIDGET_URI = "ui://joblet/job-cards";

const createServerInstance = () => {
  const server = new Server(
    { name: "Joblet - AI Job Search", version: "1.2.0" },
    {
      capabilities: {
        tools: {},
        resources: {}  // CRITICAL: tell ChatGPT we have UI resources
      }
    }
  );

  // ChatGPT calls this to discover our UI widget
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: WIDGET_URI,
        name: "Joblet Job Cards",
        description: "Renders a carousel of Joblet job listings as interactive cards",
        mimeType: "text/html"
      }
    ]
  }));

  // ChatGPT calls this to fetch the actual HTML of the widget
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === WIDGET_URI) {
      const widgetPath = path.join(__dirname, '..', 'public', 'widget', 'job-cards.html');
      let html: string;
      try {
        html = fs.readFileSync(widgetPath, 'utf-8');
      } catch {
        html = "<html><body><p>Widget not found</p></body></html>";
      }
      return {
        contents: [{ uri: WIDGET_URI, mimeType: "text/html", text: html }]
      };
    }
    throw new Error("Resource not found: " + request.params.uri);
  });

  // Tool listing - includes _meta.ui.resourceUri to link to our widget
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_jobs",
        description: "Search current Joblet jobs and side gigs by title, location, remote preference, employment type, salary, and schedule.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Job title, skill, or keyword" },
            location: { type: "string", description: "Location to search in, e.g. 'Dallas, TX'" },
            radius_miles: { type: "number", minimum: 1, maximum: 100 },
            remote: { type: "boolean" },
            employment_types: { type: "array", items: { type: "string" } },
            salary_min: { type: "number" },
            limit: { type: "number", minimum: 1, maximum: 20, default: 12 }
          },
          required: ["query"]
        },
        _meta: {
          ui: { resourceUri: WIDGET_URI }
        }
      }
    ]
  }));

  // Tool execution - returns structuredContent + _meta to trigger UI rendering
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search_jobs") {
      const args = searchJobsSchema.parse(request.params.arguments);
      try {
        const response = await fetch("https://joblet.ai/api/chatgpt/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args)
        });

        if (!response.ok) throw new Error(`Joblet API error: ${response.status}`);

        const data = await response.json();

        return {
          content: [
            {
              type: "text",
              text: `Found ${data.total || 0} Joblet opportunities.`
            }
          ],
          // Data payload sent to the iframe via openai:set_globals event
          structuredContent: data,
          // Tells ChatGPT to render our widget iframe
          _meta: {
            ui: { resourceUri: WIDGET_URI }
          }
        } as any;

      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }]
        };
      }
    }
    throw new Error("Tool not found");
  });

  return server;
};

// /mcp endpoint
app.get("/mcp", async (req, res) => {
  const server = createServerInstance();
  const transport = new SSEServerTransport("/mcp", res);
  await server.connect(transport);
  transports.set(transport.sessionId, transport);
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) { res.status(400).send("No session: " + sessionId); return; }
  await transport.handlePostMessage(req, res);
});

// Legacy /sse endpoint
app.get("/sse", async (req, res) => {
  const server = createServerInstance();
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
  transports.set(transport.sessionId, transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) { res.status(400).send("No session: " + sessionId); return; }
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Joblet MCP Server v1.2.0 running on http://localhost:${PORT}`);
});
