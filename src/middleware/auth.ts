import { createMiddleware } from "hono/factory";
import { jwtVerify, createRemoteJWKSet } from "jose";

/**
 * Cloudflare Access JWT validation middleware.
 *
 * Validates the JWT token provided by Cloudflare Access in the
 * `Cf-Access-Jwt-Assertion` header. This ensures that only authenticated
 * users who have passed through Cloudflare Access can reach your application.
 *
 * Required environment variables:
 * - CF_ACCESS_TEAM_NAME: Your Cloudflare Access team domain (e.g., your-team.cloudflareaccess.com)
 * - CF_ACCESS_AUD: The Application Audience (AUD) tag from your Access application
 */
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

    // Get the JWT from the Cloudflare Access header
    const token = c.req.header("cf-access-jwt-assertion");

    if (!token) {
      return c.json({ error: "Missing required CF Access JWT" }, 403);
    }

    try {
      // Create JWKS (JSON Web Key Set) from your team's public keys endpoint
      // This fetches the public keys used to verify the JWT signature
      const JWKS = createRemoteJWKSet(
        new URL(`https://${c.env.CF_ACCESS_TEAM_NAME}/cdn-cgi/access/certs`)
      );

      // Verify the JWT:
      // - Validates the signature using the public keys from JWKS
      // - Checks that the issuer matches your team domain
      // - Checks that the audience matches your application's AUD tag
      // - Validates expiration (exp) and not-before (nbf) claims
      await jwtVerify(token, JWKS, {
        issuer: `https://${c.env.CF_ACCESS_TEAM_NAME}`,
        audience: c.env.CF_ACCESS_AUD,
      });

      // Token is valid, proceed to the next handler
      await next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[Auth] JWT validation failed:", message);
      // Don't expose internal error details to clients
      return c.json({ error: "Invalid or expired token" }, 403);
    }
  }
);
