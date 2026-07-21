async function test() {
  const url = "https://joblet-chatgpt-app.onrender.com/mcp";
  
  try {
    const postRes = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_jobs",
          arguments: {
            query: "any job"
          }
        }
      })
    });
    
    const postText = await postRes.text();
    console.log("POST body:", postText);
  } catch(e) {
    console.error("Error:", e);
  }
}
test();
