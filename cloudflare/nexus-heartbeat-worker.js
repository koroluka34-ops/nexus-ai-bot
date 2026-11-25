// Cloudflare Worker scheduled trigger: wakes NEXUS every minute.
export default {
  async scheduled(controller, env, ctx) {
    const url = env.NEXUS_HEARTBEAT_URL ||
      "https://nexus-ai-bot-kt4w.onrender.com/heartbeat";
    ctx.waitUntil((async () => {
      const response = await fetch(url, {
        headers: { "User-Agent": "NEXUS-Cloudflare-Scheduler/1.0" }
      });
      const body = await response.text();
      console.log("NEXUS heartbeat:", response.status, body.slice(0, 300));
      if (!response.ok) throw new Error("Heartbeat HTTP " + response.status);
    })().catch(error => console.error("NEXUS heartbeat failed:", error.message)));
  }
};
