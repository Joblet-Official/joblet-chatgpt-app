// Using native fetch

async function test() {
  console.log("Connecting to SSE...");
  const sseRes = await fetch("https://joblet-chatgpt-app.onrender.com/mcp", {
    headers: { "Accept": "text/event-stream" }
  });
  
  const reader = sseRes.body;
  let endpoint = null;
  
  reader.on('data', async (chunk) => {
    const text = chunk.toString();
    console.log("SSE chunk:", text);
    
    if (text.includes("data: ")) {
      const match = text.match(/data: (.*)\n/);
      if (match) {
        endpoint = match[1];
        console.log("Endpoint found:", endpoint);
        
        // Now send initialize
        const url = new URL(endpoint, "https://joblet-chatgpt-app.onrender.com");
        console.log("Sending POST to:", url.toString());
        
        const postRes = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "test", version: "1.0" }
            }
          })
        });
        
        console.log("POST status:", postRes.status);
        const postText = await postRes.text();
        console.log("POST body:", postText);
        process.exit(0);
      }
    }
  });
}
test();
