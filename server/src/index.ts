import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Get current directory for static files (ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Security: Restrict CORS to Joblet domains and OpenAI for production
const allowedOrigins = [
  "https://joblet.ai",
  "https://www.joblet.ai",
  "https://api.joblet.ai",
  "https://mcp.joblet.ai",
  "https://chatgpt.com"
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like server-to-server or curl) during dev
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1 && !origin.includes("localhost")) {
      return callback(new Error('CORS policy violation'), false);
    }
    return callback(null, true);
  }
}));

// Serve static widget files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Basic root health/status
app.get("/", (req, res) => {
  res.status(200).json({
    name: "Joblet ChatGPT App",
    status: "running",
    mcp: "/mcp"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "joblet-chatgpt-app",
    version: "1.1.0"
  });
});

// OpenAI Domain Verification Challenge
app.get("/.well-known/openai-apps-challenge", (req, res) => {
  const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (!token) {
    return res.status(404).send("Not configured");
  }
  res.type("text/plain").send(token);
});

const searchJobsSchema = z.object({
  query: z.string().describe("Job title, skill, or keyword"),
  location: z.string().optional().describe("Location to search in, e.g. 'Dallas, TX'"),
  radius_miles: z.number().min(1).max(100).optional(),
  remote: z.boolean().optional(),
  employment_types: z.array(z.string()).optional(),
  salary_min: z.number().optional(),
  limit: z.number().min(1).max(20).default(12)
});

// Store active transports mapped by sessionId
const transports = new Map<string, SSEServerTransport>();

// Helper function to create an MCP Server instance per connection
const createServerInstance = () => {
  const server = new Server(
    { name: "Joblet - AI Job Search", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search_jobs",
          description: "Search current Joblet jobs and side gigs by title, location, remote preference, employment type, salary, experience, and schedule.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Job title, skill, or keyword" },
              location: { type: "string", description: "Location to search in" },
              radius_miles: { type: "number", minimum: 1, maximum: 100 },
              remote: { type: "boolean" },
              employment_types: { type: "array", items: { type: "string" } },
              salary_min: { type: "number" },
              limit: { type: "number", minimum: 1, maximum: 20, default: 12 }
            },
            required: ["query"]
          },
          // OpenAI specific annotations for UI widgets
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
          },
          // ChatGPT Apps SDK UI Widget Metadata
          _meta: {
            "openai/outputTemplate": "ui://widget/carousel.html",
            "openai/widgetAccessible": true
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search_jobs") {
      const args = searchJobsSchema.parse(request.params.arguments);
      try {
        const response = await fetch("https://joblet.ai/api/chatgpt/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args)
        });

        if (!response.ok) {
          throw new Error(`Joblet API returned status ${response.status}`);
        }

        const data = await response.json();
        
        // Return both the markdown fallback and the structured UI data for the widget
        return {
          content: [
            {
              type: "text",
              text: `Found ${data.total || 0} matching Joblet opportunities. The UI widget should render these.`
            }
          ],
          // This is injected directly into window.openai.toolOutput for our carousel.html
          structuredContent: data 
        } as any; // Cast as any because structuredContent / _meta might not be in official TS types yet

      } catch (error) {
        console.error(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error performing search: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
    throw new Error("Tool not found");
  });

  return server;
};

// --- MODERN /mcp ENDPOINT ---
app.get("/mcp", async (req, res) => {
  const server = createServerInstance();
  const transport = new SSEServerTransport("/mcp", res);
  await server.connect(transport);
  transports.set(transport.sessionId, transport);
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).send("MCP connection not established for session: " + sessionId);
    return;
  }
  await transport.handlePostMessage(req, res);
});


// --- LEGACY /sse ENDPOINT (For backwards compatibility) ---
app.get("/sse", async (req, res) => {
  const server = createServerInstance();
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
  transports.set(transport.sessionId, transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).send("SSE connection not established for session: " + sessionId);
    return;
  }
  await transport.handlePostMessage(req, res);
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Joblet MCP Server running on http://localhost:${PORT}`);
});
