async function test() {
  const url = "https://joblet-chatgpt-app.onrender.com/mcp";
  const start = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "resources/read",
      params: { uri: "ui://joblet/job-cards-v3" }
    })
  });
  const text = await res.text();
  console.log("Response text length:", text.length);
  console.log("Time taken:", Date.now() - start, "ms");
}
test();
