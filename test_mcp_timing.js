async function test() {
  const url = "https://joblet-chatgpt-app.onrender.com/mcp";
  const start = Date.now();
  console.log("Sending POST to /mcp...");
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_jobs", arguments: { query: "cdl" } }
    })
  });
  const text = await res.text();
  console.log("Response text:", text);
  console.log("Response length:", text.length);
  console.log("Time taken:", Date.now() - start, "ms");
}
test();
