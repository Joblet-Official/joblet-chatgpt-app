import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import cors from "cors";

// Initialize the Express app
const app = express();
app.use(cors());
app.use(express.json());

const server = new Server(
  {
    name: "Joblet - AI Job Search",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const searchJobsSchema = z.object({
  query: z.string().describe("Job title, skill, or keyword"),
  location: z.string().optional().describe("Location to search in, e.g. 'Dallas, TX'"),
  radius_miles: z.number().min(1).max(100).optional(),
  remote: z.boolean().optional(),
  employment_types: z.array(z.string()).optional(),
  salary_min: z.number().optional(),
  limit: z.number().min(1).max(20).default(12)
});

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
            location: { type: "string", description: "Location to search in, e.g. 'Dallas, TX'" },
            radius_miles: { type: "number", minimum: 1, maximum: 100 },
            remote: { type: "boolean" },
            employment_types: { type: "array", items: { type: "string" } },
            salary_min: { type: "number" },
            limit: { type: "number", minimum: 1, maximum: 20, default: 12 }
          },
          required: ["query"]
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

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.total} matching Joblet opportunities.\n\n${JSON.stringify(data.jobs, null, 2)}`
          }
        ]
      };
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

// Setup SSE Transport
let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
  console.log("Client connected via SSE");
});

app.post("/messages", async (req, res) => {
  if (!transport) {
    res.status(400).send("SSE connection not established");
    return;
  }
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Joblet MCP Server running on http://localhost:${PORT}`);
  console.log(`SSE endpoint available at http://localhost:${PORT}/sse`);
});
