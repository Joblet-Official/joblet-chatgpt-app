import { EventSource } from 'eventsource';

async function test() {
  console.log("Connecting to /sse...");
  const es = new EventSource("http://localhost:3001/sse");
  
  let endpoint = null;

  es.onmessage = async (e) => {
    console.log("SSE Message:", e.data);
  };

  es.addEventListener("endpoint", async (e) => {
    console.log("Got endpoint:", e.data);
    endpoint = e.data;
    const url = new URL(endpoint, "http://localhost:3001");
    console.log("Resolved URL:", url.href);
    
    console.log("Sending tools/list to", url.href);
    const res = await fetch(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/list", params: {}
      })
    });
    console.log("POST status:", res.status);
    const text = await res.text();
    console.log("POST body:", text);
    es.close();
  });

  es.onerror = (e) => {
    console.error("SSE Error:", e);
    es.close();
  };
}

test();
