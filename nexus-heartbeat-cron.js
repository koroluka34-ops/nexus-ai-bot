// Render Cron Job: runs once per minute and wakes the NEXUS web service.
const url = process.env.NEXUS_HEARTBEAT_URL ||
  "https://nexus-ai-bot-kt4w.onrender.com/heartbeat";

(async () => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(110000),
    headers: { "User-Agent": "NEXUS-Autonomous-Scheduler/1.0" }
  });
  const body = await response.text();
  console.log("NEXUS heartbeat:", response.status, body.slice(0, 300));
  if (!response.ok) process.exitCode = 1;
})().catch(error => {
  console.error("NEXUS heartbeat failed:", error.message);
  process.exitCode = 1;
});
