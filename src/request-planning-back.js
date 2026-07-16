const http = require("http");
const { Server } = require("socket.io");
const { env } = require("./config/env");
const { createApp } = require("./app");
const { registerRealtime } = require("./services/realtimeService");
const { startEndDateReminderScheduler } = require("./services/endDateReminderService");

const app = createApp();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: env.frontendOrigins, credentials: true },
  path: "/ws"
});
registerRealtime(io);

server.listen(env.apiPort, env.apiHost, () => {
  console.log(`Request & Planning API running at http://${env.apiHost}:${env.apiPort}`);
  // Daily 08:30 end-date reminder digests (skips company holidays).
  startEndDateReminderScheduler();
});
