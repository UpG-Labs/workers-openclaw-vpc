# Option B: Implementation Guide

This document provides the exact code changes and configuration steps needed to implement Option B (direct JWT authentication) instead of the current proxy approach.

## Prerequisites

Before implementing Option B, ensure:

1. ✅ You have a custom domain added to Cloudflare
2. ✅ Your Worker is deployed to that custom domain (not workers.dev)
3. ✅ You have access to Cloudflare Zero Trust Dashboard

## Step 1: Cloudflare Access Configuration

### 1.1 Create Access Application

1. Navigate to: [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Go to: **Access** → **Applications** → **Add an application**
3. Select: **Self-hosted**
4. Configure:

   ```
   Application name: OpenClaw Workers Gateway
   Session Duration: 24 hours
   Application domain: openclaw-gateway.example.com  (your custom domain)
   ```

5. Click **Next**

### 1.2 Configure Access Policy

1. **Policy name**: Allow authenticated users
2. **Action**: Allow
3. **Configure rules**:
   - Rule type: Include
   - Selector: Emails
   - Value: `user@example.com` (or use email domain, groups, etc.)

4. Click **Next** and **Add application**

5. **Important**: Copy the **Application Audience (AUD)** tag from the application overview

### 1.3 Configure Authentication Settings

1. Go to: **Settings** → **Authentication**
2. Verify settings:
   - **Session duration**: 24 hours (or your preference)
   - **Cookie settings**:
     - HTTP-Only: ✅ Enabled
     - SameSite: `Lax` or `Strict`
     - Secure: ✅ Enabled

### 1.4 Configure CORS Settings (if needed)

Since the requests are same-origin (chat.html calling the same Worker), CORS shouldn't be an issue. However, if you encounter CORS errors, you may need to add CORS headers in your Worker.

## Step 2: Worker Configuration Changes

### 2.1 Update wrangler.jsonc

Ensure your Worker is configured with custom domain routes:

```jsonc
{
  "name": "openclaw-workers-vpc",
  "routes": [
    {
      "pattern": "openclaw-gateway.example.com/*",
      "zone_name": "example.com"
    }
  ],
  // ... rest of config
}
```

### 2.2 Update Environment Variables

The existing environment variables remain the same:

```bash
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put CF_ACCESS_TEAM_NAME
npx wrangler secret put OPENCLAW_GATEWAY_TOKEN
```

**Note**: Service token secrets (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) are optional for Option B but can remain configured if you want to keep that capability.

## Step 3: Code Changes

### 3.1 Revert chat.html to Call /v1/chat/completions Directly

**File**: `public/chat.html`

**Change from**:
```javascript
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
```

**Change to**:
```javascript
const response = await fetch("/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  credentials: "include", // Ensures cookies are sent
  body: JSON.stringify({
    model: "openclaw:main",
    messages: conversationHistory,
    stream: true,
  }),
});
```

**Key Addition**: `credentials: "include"` ensures that the browser sends cookies (including the Cloudflare Access session cookie) with the fetch request.

### 3.2 Remove Proxy Endpoint (Optional)

**File**: `src/index.ts`

You can remove the `/api/chat/completions` endpoint:

```typescript
// Remove these lines (lines 9-36):
// app.post("/api/chat/completions", async (c) => {
//   ...
// });
```

**Note**: Keeping the proxy endpoint doesn't hurt, so you can leave it for backward compatibility if desired.

### 3.3 Add CORS Middleware (Optional)

If you encounter CORS issues during testing, add this middleware:

**File**: `src/index.ts`

**Add before the accessAuth middleware**:

```typescript
import { Hono } from "hono";
import { accessAuth } from "./middleware/auth";
import { cors } from "hono/cors";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Optional: Add CORS support for same-origin requests
app.use("*", cors({
  origin: (origin) => origin, // Allow same origin
  credentials: true,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "cf-access-jwt-assertion"],
}));

// Handle OPTIONS preflight requests
app.options("*", (c) => c.text("", 204));

// Protect all routes with Cloudflare Access JWT validation
app.use("*", accessAuth);

// ... rest of the code
```

**Note**: Install hono/cors if not already available: `npm install hono`

### 3.4 Enhance Error Messages (Optional)

**File**: `src/middleware/auth.ts`

Enhance the error message when JWT is missing:

```typescript
if (!token) {
  console.error("[Auth] Missing JWT. Ensure Cloudflare Access is protecting this domain.");
  return c.json({
    error: "Missing required CF Access JWT or service token",
    hint: "Ensure you are accessing this service through the Cloudflare Access protected domain"
  }, 403);
}
```

## Step 4: Deployment

### 4.1 Deploy Worker to Custom Domain

```bash
npm run deploy
```

### 4.2 Verify Access Application

1. Visit your custom domain: `https://openclaw-gateway.example.com`
2. You should be redirected to Cloudflare Access login
3. After authentication, you should reach the application

### 4.3 Test Chat Functionality

1. Navigate to: `https://openclaw-gateway.example.com/chat.html`
2. You should be authenticated via Cloudflare Access
3. Try sending a chat message
4. Verify that the request to `/v1/chat/completions` works

**Expected Behavior**:
- Browser sends request to `/v1/chat/completions`
- Cloudflare Access validates session cookie
- Cloudflare Access injects `cf-access-jwt-assertion` header
- Worker middleware validates JWT
- Request succeeds

## Step 5: Troubleshooting

### Issue: 403 Forbidden on /v1/chat/completions

**Possible Causes**:

1. **Cloudflare Access not configured**: Verify the application is created and active
2. **Session expired**: Log out and log back in to Cloudflare Access
3. **Cookie not sent**: Verify `credentials: "include"` is in the fetch call
4. **Different domain**: Ensure chat.html and API are on the same domain

**Debug Steps**:

```javascript
// Add this to chat.html for debugging
console.log("Request URL:", "/v1/chat/completions");
console.log("Current origin:", window.location.origin);

const response = await fetch("/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  credentials: "include",
  body: JSON.stringify({...}),
});

console.log("Response status:", response.status);
console.log("Response headers:", [...response.headers.entries()]);
```

### Issue: CORS Error

**Solution**: Add the CORS middleware shown in Step 3.3

### Issue: Works in Browser but Not in Development

**Expected**: Cloudflare Access requires a custom domain and doesn't work with:
- `localhost`
- `workers.dev` domains

**Solution**: Use Option A (proxy endpoint) for local development, or set up a development Access application.

## Step 6: Testing Checklist

- [ ] User can access `/chat.html` after Cloudflare Access authentication
- [ ] Chat messages send successfully to `/v1/chat/completions`
- [ ] Streaming responses work correctly
- [ ] Browser console shows no CORS errors
- [ ] Worker logs show JWT validation succeeding
- [ ] Session persists across page refreshes (within session duration)

## Comparison with Current Implementation

### What Changes:

1. **chat.html**: Calls `/v1/chat/completions` instead of `/api/chat/completions`
2. **Fetch call**: Adds `credentials: "include"`
3. **Deployment**: Must use custom domain with Cloudflare Access

### What Stays the Same:

1. **Authentication middleware**: No changes needed
2. **Environment variables**: Same variables (service tokens optional)
3. **Security level**: Same authentication requirements

## Rollback Plan

If Option B doesn't work, you can easily rollback:

1. Revert chat.html to call `/api/chat/completions`
2. Keep the proxy endpoint in place
3. Everything continues working as before

## Conclusion

Option B provides a simpler architecture by eliminating the proxy endpoint, but requires:
- Custom domain setup
- Proper Cloudflare Access configuration
- `credentials: "include"` in fetch calls

The current Option A implementation is more flexible and works with workers.dev domains, making it better for development environments.
