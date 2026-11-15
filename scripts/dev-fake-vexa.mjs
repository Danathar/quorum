// A tiny stand-in for the Vexa gateway, for running quorum locally without Vexa:
//   node scripts/dev-fake-vexa.mjs            # listens on 127.0.0.1:18056, API key "dev-key"
// It accepts every bot, walks it joining -> awaiting_admission -> active over /ws, then sends a
// transcript line and a chat line every few seconds. See README "Local development".
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.FAKE_VEXA_PORT ?? 18056);
const KEY = process.env.FAKE_VEXA_KEY ?? "dev-key";
const STEP_MS = 1500;
const LINE_MS = 4000;
const rows = [];
let nextId = 1;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    if (req.headers["x-api-key"] !== KEY) return send(res, 401, { detail: "Invalid API key" });
    const path = (req.url ?? "/").split("?")[0];
    console.log(`fake-vexa ${req.method} ${path}`);
    if (req.method === "POST" && path === "/bots") {
      const b = JSON.parse(text || "{}");
      const row = {
        id: nextId++,
        platform: b.platform,
        native_meeting_id: b.native_meeting_id,
        status: "requested",
      };
      rows.unshift(row);
      return send(res, 201, row);
    }
    if (req.method === "GET" && path === "/bots") return send(res, 200, { meetings: rows });
    if (req.method === "POST" && /\/chat$/.test(path))
      return send(res, 200, { status: "queued", request_id: "r1" });
    if (req.method === "POST" && /\/speak$/.test(path)) return send(res, 200, { status: "queued" });
    if (req.method === "DELETE") return send(res, 200, { status: "stopping" });
    return send(res, 404, { detail: "Not Found" });
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  if (req.headers["x-api-key"] !== KEY) {
    ws.send(JSON.stringify({ type: "error", error: "invalid_api_key" }));
    return ws.close(4401);
  }
  const timers = [];
  ws.on("close", () => timers.forEach(clearInterval));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.action !== "subscribe") return;
    ws.send(JSON.stringify({ type: "subscribed", meetings: msg.meetings }));
    for (const m of msg.meetings) {
      const row = rows.find((r) => r.native_meeting_id === m.native_id) ?? { id: 0 };
      const meeting = { id: row.id, platform: m.platform, native_id: m.native_id };
      const status = (s) => ({ type: "meeting.status", meeting, payload: { status: s } });
      ["joining", "awaiting_admission", "active"].forEach((s, i) =>
        setTimeout(
          () => ws.readyState === ws.OPEN && ws.send(JSON.stringify(status(s))),
          STEP_MS * (i + 1),
        ),
      );
      let n = 0;
      timers.push(
        setInterval(() => {
          n += 1;
          const seg = {
            segment_id: `dev:${n}`,
            speaker: n % 2 ? "Alice" : "Bob",
            text: `Line ${n} of the fake meeting.`,
            start: n * 4,
            end: n * 4 + 3,
            completed: true,
          };
          ws.send(JSON.stringify({ type: "transcript", meeting, confirmed: [seg], pending: [] }));
          if (n % 3 === 0)
            ws.send(
              JSON.stringify({
                type: "chat_message",
                meeting,
                sender: "Alice",
                text: `chat ${n}`,
                timestamp: Date.now(),
              }),
            );
        }, LINE_MS),
      );
    }
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`fake-vexa on http://127.0.0.1:${PORT} (key ${KEY})`),
);
