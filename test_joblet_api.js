async function test() {
  const params = new URLSearchParams();
  params.set("q", "any job");
  
  const url = `https://joblet.ai/api/jobs?${params.toString()}`;
  console.log("Fetching:", url);
  
  const response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });
  
  const raw = await response.json();
  console.log("Raw Response:", JSON.stringify(raw, null, 2));
  console.log("Raw total:", raw.pagination?.total);
  console.log("Raw jobs length:", (raw.jobs || []).length);
}
test();
