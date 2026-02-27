import { Hono } from "hono";
import { accessAuth } from "./middleware/auth";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Protect all routes with Cloudflare Access JWT validation
app.use("*", accessAuth);

// OpenAI-compatible Chat Completions API
// Enable API access in your Gateway to use this
app.post("/v1/chat/completions", async (c) => {
  if (!c.env.OPENCLAW_GATEWAY_TOKEN) {
    console.error("[Chat] OPENCLAW_GATEWAY_TOKEN secret is not set");
    return c.json({ error: "Server configuration error" }, 500);
  }

  try {
    const body = await c.req.text();
    const response = await c.env.VPC_SERVICE.fetch(
      "http://localhost:18789/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Origin": "http://localhost:18789",
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.env.OPENCLAW_GATEWAY_TOKEN}`,
        },
        body: body,
      },
    );
    return response;
  } catch (e) {
    console.error("[Chat] Error:", e);
    return c.json({ error: "Failed to process chat request" }, 500);
  }
});

// Tools invocation API
app.post("/tools/invoke", async (c) => {
  try {
    const mergedHeaders = new Headers(c.req.raw.headers);
    mergedHeaders.set('Origin', 'http://localhost:18789');
    return await c.env.VPC_SERVICE.fetch(
      "http://localhost:18789/tools/invoke",
      {
        method: "POST",
        headers: mergedHeaders,
        body: c.req.raw.body,
      },
    );
  } catch (e) {
    console.error("[Tools] Error:", e);
    return c.json({ error: "Failed to invoke tool" }, 500);
  }
});

// Below routes proxy the default UI
// SPA assets (when accessed from /app/* routes)
app.get("/app/assets/*", async (c) => {
  const url = new URL(c.req.url);
  const assetPath = url.pathname.replace("/app/assets", "/assets");
  return c.env.VPC_SERVICE.fetch(
    `http://localhost:18789${assetPath}`,
    {
      headers: {
        "Origin": "http://localhost:18789",
      },
    },
  );
});

// Favicon for SPA routes
app.get("/app/favicon.ico", async (c) => {
  return c.env.VPC_SERVICE.fetch(
    "http://localhost:18789/favicon.ico",
    {
      headers: {
        "Origin": "http://localhost:18789",
      },
    },
  );
});

// Logo for SPA routes
app.get("/app/favicon.svg", async (c) => {
  return c.env.VPC_SERVICE.fetch(
    "http://localhost:18789/favicon.svg",
    {
      headers: {
        "Origin": "http://localhost:18789",
      },
    },
  );
});

// SPA catch-all (serves HTML for all /app/* routes)
app.get("/app/*", async (c) => {
  return c.env.VPC_SERVICE.fetch(
    "http://localhost:18789/",
    {
      headers: {
        "Origin": "http://localhost:18789",
      },
    },
  );
});

// Direct assets (fallback)
app.get("/assets/*", async (c) => {
  const url = new URL(c.req.url);
  return c.env.VPC_SERVICE.fetch(
    `http://localhost:18789${url.pathname}`,
    {
      headers: {
        "Origin": "http://localhost:18789",
      },
    },
  );
});

// Root: WebSocket proxy + redirect
app.get("/", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader === "websocket") {
    try {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      const openclawResponse = await c.env.VPC_SERVICE.fetch(
        "http://localhost:18789/",
        {
          headers: {
            Origin: "http://localhost:18789",
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key":
              c.req.header("Sec-WebSocket-Key") || "dGhlIHNhbXBsZSBub25jZQ==",
          },
        },
      );
      const openclawWs = openclawResponse.webSocket;
      if (!openclawWs) {
        console.error(
          "[WS] Failed to establish WebSocket connection to OpenClaw",
        );
        return new Response("Failed to connect to OpenClaw WebSocket", {
          status: 502,
        });
      }
      server.accept();
      openclawWs.accept();
      // Bridge: Client ↔ OpenClaw
      server.addEventListener("message", (event) => {
        try {
          openclawWs.send(event.data);
        } catch (e) {
          console.error("[WS] Error forwarding to OpenClaw:", e);
        }
      });
      server.addEventListener("close", (event) => {
        try {
          openclawWs.close(event.code, event.reason);
        } catch {}
      });
      server.addEventListener("error", () => {
        try {
          openclawWs.close(1011, "Client error");
        } catch {}
      });
      openclawWs.addEventListener("message", (event) => {
        try {
          server.send(event.data);
        } catch (e) {
          console.error("[WS] Error forwarding to client:", e);
        }
      });
      openclawWs.addEventListener("close", (event) => {
        try {
          server.close(event.code, event.reason);
        } catch {}
      });
      openclawWs.addEventListener("error", () => {
        try {
          server.close(1011, "Server error");
        } catch {}
      });
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    } catch (error) {
      console.error("[WS] WebSocket proxy error:", error);
      return new Response(`WebSocket proxy error: ${error}`, { status: 502 });
    }
  }
  return c.redirect("/app");
});

app.all("*", (c) => {
  console.log(`[404] Unmatched route: ${c.req.method} ${c.req.path}`);
  return c.json({ error: "Not found" }, 404);
});

app.onError((err, c) => {
  console.error(`[Error] Unhandled: ${err.message}`);
  // Don't expose internal error details to clients
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
