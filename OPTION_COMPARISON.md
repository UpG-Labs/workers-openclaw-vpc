# Option A vs Option B: Code Comparison

This document provides a side-by-side comparison of the code implementations for both options.

## Architecture Overview

### Option A (Current Implementation)
```
User Browser → Cloudflare Access → Worker
  └─ /chat.html (authenticated)
  └─ Fetch to /api/chat/completions
       └─ Worker validates JWT
       └─ Worker proxies to VPC_SERVICE
            └─ OpenClaw at localhost:18789
```

### Option B (Alternative)
```
User Browser → Cloudflare Access → Worker
  └─ /chat.html (authenticated)
  └─ Fetch to /v1/chat/completions
       └─ Cloudflare Access injects JWT
       └─ Worker validates JWT
       └─ Worker proxies to VPC_SERVICE
            └─ OpenClaw at localhost:18789
```

## Code Changes

### 1. chat.html

#### Option A (Current)
```javascript
// Line 280 in public/chat.html
try {
  const response = await fetch("/api/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw:main",
      messages: conversationHistory,
      stream: true,
    }),
  });
  // ... rest of code
}
```

#### Option B (Alternative)
```javascript
// Line 280 in public/chat.html
try {
  const response = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",  // ← KEY ADDITION: Sends cookies
    body: JSON.stringify({
      model: "openclaw:main",
      messages: conversationHistory,
      stream: true,
    }),
  });
  // ... rest of code
}
```

**Key Difference**:
- Option A: Calls proxy endpoint `/api/chat/completions`
- Option B: Calls original endpoint `/v1/chat/completions` with `credentials: "include"`

### 2. src/index.ts

#### Option A (Current)
```typescript
import { Hono } from "hono";
import { accessAuth } from "./middleware/auth";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Protect all routes with Cloudflare Access JWT validation
app.use("*", accessAuth);

// Chat proxy endpoint - allows authenticated users to call the chat API
// This endpoint directly calls the VPC service, bypassing the need for service tokens
app.post("/api/chat/completions", async (c) => {
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

// OpenAI-compatible Chat Completions API
app.post("/v1/chat/completions", async (c) => {
  // ... existing code
});

// ... rest of routes
```

#### Option B (Alternative)
```typescript
import { Hono } from "hono";
import { accessAuth } from "./middleware/auth";
import { cors } from "hono/cors";  // ← Optional: for CORS support

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Optional: Add CORS support if needed
app.use("*", cors({
  origin: (origin) => origin,
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "cf-access-jwt-assertion"],
}));

// Handle OPTIONS preflight
app.options("*", (c) => c.text("", 204));

// Protect all routes with Cloudflare Access JWT validation
app.use("*", accessAuth);

// NO PROXY ENDPOINT NEEDED - chat.html calls /v1/chat/completions directly

// OpenAI-compatible Chat Completions API
app.post("/v1/chat/completions", async (c) => {
  // ... existing code (unchanged)
});

// ... rest of routes
```

**Key Difference**:
- Option A: Has `/api/chat/completions` proxy endpoint
- Option B: No proxy endpoint; optional CORS middleware; chat.html calls `/v1/chat/completions` directly

### 3. src/middleware/auth.ts

#### Both Options (Same Code)

```typescript
import { createMiddleware } from "hono/factory";
import { jwtVerify, createRemoteJWKSet } from "jose";

export const accessAuth = createMiddleware<{ Bindings: CloudflareBindings }>(
  async (c, next) => {
    // Verify required environment variables are set
    if (!c.env.CF_ACCESS_TEAM_NAME) {
      console.error("[Auth] CF_ACCESS_TEAM_NAME environment variable is not set");
      return c.json({ error: "Server configuration error" }, 500);
    }

    if (!c.env.CF_ACCESS_AUD) {
      console.error("[Auth] CF_ACCESS_AUD secret is not set");
      return c.json({ error: "Server configuration error" }, 500);
    }

    // Check for service token authentication first
    const clientId = c.req.header("CF-Access-Client-Id");
    const clientSecret = c.req.header("CF-Access-Client-Secret");

    if (clientId && clientSecret) {
      // Validate service token
      if (
        c.env.CF_ACCESS_CLIENT_ID &&
        c.env.CF_ACCESS_CLIENT_SECRET &&
        clientId === c.env.CF_ACCESS_CLIENT_ID &&
        clientSecret === c.env.CF_ACCESS_CLIENT_SECRET
      ) {
        console.log("[Auth] Service token validated successfully");
        await next();
        return;
      } else {
        console.error("[Auth] Invalid service token credentials");
        return c.json({ error: "Invalid service token" }, 403);
      }
    }

    // Fall back to user JWT authentication
    const token = c.req.header("cf-access-jwt-assertion");

    if (!token) {
      return c.json({ error: "Missing required CF Access JWT or service token" }, 403);
    }

    try {
      const JWKS = createRemoteJWKSet(
        new URL(`https://${c.env.CF_ACCESS_TEAM_NAME}/cdn-cgi/access/certs`)
      );

      await jwtVerify(token, JWKS, {
        issuer: `https://${c.env.CF_ACCESS_TEAM_NAME}`,
        audience: c.env.CF_ACCESS_AUD,
      });

      await next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[Auth] JWT validation failed:", message);
      return c.json({ error: "Invalid or expired token" }, 403);
    }
  }
);
```

**Key Point**: The middleware is identical for both options. It already supports JWT validation, which is all that's needed for Option B.

## Configuration Changes

### wrangler.jsonc

#### Option A (Current - Works with workers.dev)
```jsonc
{
  "name": "openclaw-workers-vpc",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-28",
  // No custom routes needed
  "vpc_services": [{
    "binding": "VPC_SERVICE",
    "service_id": "019c8bd1-443d-7170-96dd-d924e6432051",
    "remote": true
  }]
}
```

#### Option B (Requires Custom Domain)
```jsonc
{
  "name": "openclaw-workers-vpc",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-28",
  "routes": [
    {
      "pattern": "openclaw-gateway.example.com/*",
      "zone_name": "example.com"
    }
  ],
  "vpc_services": [{
    "binding": "VPC_SERVICE",
    "service_id": "019c8bd1-443d-7170-96dd-d924e6432051",
    "remote": true
  }]
}
```

### Environment Variables

#### Both Options (Same)
```bash
CF_ACCESS_AUD=xxx
CF_ACCESS_TEAM_NAME=your-team.cloudflareaccess.com
CF_ACCESS_CLIENT_ID=xxx        # Optional but recommended
CF_ACCESS_CLIENT_SECRET=xxx    # Optional but recommended
OPENCLAW_GATEWAY_TOKEN=xxx
```

## Cloudflare Access Configuration

### Option A (Current)
- ✅ Works without Cloudflare Access on custom domain
- ✅ Can use workers.dev domain
- ✅ Suitable for development
- ⚠️ Still validates JWT if Access is configured

### Option B (Alternative)
- ⚠️ **Requires** Cloudflare Access on custom domain
- ❌ Does not work with workers.dev
- ❌ Does not work in local development
- ✅ Simpler architecture in production

#### Required Access Configuration for Option B

**Application Setup:**
```
Dashboard: Cloudflare Zero Trust → Access → Applications

Application Name: OpenClaw Workers Gateway
Application Domain: openclaw-gateway.example.com
Session Duration: 24 hours
Path: /* (all paths)
```

**Policy Setup:**
```
Policy Name: Allow authenticated users
Action: Allow
Include:
  - Emails: user@example.com
  - Or: Email domain: example.com
  - Or: Country: United States
  (Configure based on your needs)
```

**Cookie Settings:**
```
Dashboard: Cloudflare Zero Trust → Settings → Authentication

Session Duration: 24 hours
Cookie Settings:
  - HTTP-Only: ✅ Enabled
  - Secure: ✅ Enabled
  - SameSite: Lax or Strict
```

## Request Flow Comparison

### Option A: Browser → Proxy → VPC

```
1. User authenticated via CF Access
2. Browser loads /chat.html
3. JavaScript: fetch("/api/chat/completions")
   ├─ CF Access validates session → injects JWT
   ├─ Worker middleware validates JWT
   └─ Worker proxy endpoint called
4. Proxy: c.env.VPC_SERVICE.fetch("http://localhost:18789/v1/chat/completions")
   ├─ Adds Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
   └─ Calls OpenClaw service
5. Response streams back through proxy to browser
```

### Option B: Browser → Direct → VPC

```
1. User authenticated via CF Access
2. Browser loads /chat.html
3. JavaScript: fetch("/v1/chat/completions", {credentials: "include"})
   ├─ Browser sends cookies
   ├─ CF Access validates session → injects JWT
   └─ Worker middleware validates JWT
4. /v1/chat/completions endpoint: c.env.VPC_SERVICE.fetch(...)
   ├─ Adds Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
   └─ Calls OpenClaw service
5. Response streams back directly to browser
```

**Key Difference**: Option B has one fewer hop (no proxy layer).

## Testing

### Testing Option A (Current)

```bash
# Works with any domain
curl https://your-worker.workers.dev/chat.html

# Or custom domain
curl https://openclaw-gateway.example.com/chat.html
```

### Testing Option B (Alternative)

```bash
# MUST use custom domain with CF Access
curl https://openclaw-gateway.example.com/chat.html

# Will NOT work:
curl https://your-worker.workers.dev/chat.html  # ❌ No CF Access on workers.dev
curl http://localhost:8787/chat.html            # ❌ No CF Access in dev
```

## Decision Matrix

| Criterion | Option A | Option B |
|-----------|----------|----------|
| Works with workers.dev | ✅ Yes | ❌ No |
| Local development | ✅ Yes | ❌ No |
| Custom domain required | ❌ No | ✅ Yes |
| CF Access required | ❌ No | ✅ Yes |
| Code complexity | Medium | Low |
| Number of endpoints | +1 proxy | Same |
| Service token support | ✅ Yes | Optional |
| Production simplicity | Medium | High |
| Setup complexity | Low | High |
| Request latency | Slightly higher | Slightly lower |

## Recommendation

- **Use Option A (Current)** if:
  - You want to develop/test with workers.dev
  - You don't have a custom domain yet
  - You prefer flexibility
  - You want service token support

- **Use Option B** if:
  - You're deploying to production with custom domain
  - Cloudflare Access is already configured
  - You want simpler architecture
  - You don't need local development

## Migration Path

To migrate from Option A to Option B:

1. Set up custom domain + Cloudflare Access
2. Update chat.html fetch call (add `credentials: "include"`, change URL)
3. Optionally remove proxy endpoint
4. Deploy and test
5. Rollback if issues (revert chat.html changes)

The middleware doesn't need changes, making migration safe and reversible.
