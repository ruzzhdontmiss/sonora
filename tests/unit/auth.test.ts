import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  hashToken,
  createSession,
  validateSessionToken,
  invalidateSession,
} from "@/modules/auth/service";
import { prisma } from "@/lib/db";
import { SignJWT } from "jose";
import { getEnv } from "@/config/env";
import { POST as loginHandler, GET as loginGetHandler } from "@/app/api/auth/login/route";
import { POST as logoutHandler, GET as logoutGetHandler } from "@/app/api/auth/logout/route";
import { GET as meHandler } from "@/app/api/auth/me/route";
import { validateRequestOrigin } from "@/lib/csrf";

describe("Authentication & Session Security (P1-T06 Security Review)", () => {
  const testUserId = "00000000-0000-0000-0000-000000000001";
  const existingVictimEmail = "victim@example.com";
  let victimUserId: string;

  beforeEach(async () => {
    // Ensure synthetic test user exists
    await prisma.user.upsert({
      where: { id: testUserId },
      update: {},
      create: {
        id: testUserId,
        email: "synthetic-user@example.com",
        displayName: "Synthetic Demo User",
      },
    });

    // Create a preexisting user to test account takeover resistance
    const victim = await prisma.user.upsert({
      where: { email: existingVictimEmail },
      update: {},
      create: {
        email: existingVictimEmail,
        displayName: "Victim User",
      },
    });
    victimUserId = victim.id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: testUserId } });
    await prisma.session.deleteMany({ where: { userId: victimUserId } });
    await prisma.user.deleteMany({ where: { email: existingVictimEmail } });
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. UNIT TESTS: Cryptographic Hashing & Session Invariants
  // =========================================================================
  it("hashes tokens deterministically with SHA-256", () => {
    const raw = "sample-secret-token";
    const hash1 = hashToken(raw);
    const hash2 = hashToken(raw);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("creates a signed JWT and persists the session in database", async () => {
    const sessionJwt = await createSession(testUserId);
    expect(typeof sessionJwt).toBe("string");
    expect(sessionJwt.split(".")).toHaveLength(3);

    const authContext = await validateSessionToken(sessionJwt);
    expect(authContext).not.toBeNull();
    expect(authContext?.user.id).toBe(testUserId);
    expect(authContext?.user.email).toBe("synthetic-user@example.com");
  });

  it("rejects unauthenticated access with null or invalid token", async () => {
    expect(await validateSessionToken("")).toBeNull();
    expect(await validateSessionToken("invalid.jwt.token")).toBeNull();
    expect(await validateSessionToken("random-string-not-a-jwt")).toBeNull();
  });

  it("rejects tampered JWT signature with modified payload", async () => {
    const sessionJwt = await createSession(testUserId);
    const [header, payload, signature] = sessionJwt.split(".");

    const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString());
    decodedPayload.userId = "attacker-user-id";
    const tamperedPayload = Buffer.from(JSON.stringify(decodedPayload)).toString("base64url");
    const tamperedJwt = `${header}.${tamperedPayload}.${signature}`;

    const result = await validateSessionToken(tamperedJwt);
    expect(result).toBeNull();
  });

  it("rejects JWT when token hash does not match database record", async () => {
    const dbSession = await prisma.session.create({
      data: {
        userId: testUserId,
        tokenHash: hashToken("correct-token"),
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    const secretBytes = new TextEncoder().encode(getEnv().AUTH_SECRET);
    const forgedJwt = await new SignJWT({
      sessionId: dbSession.id,
      userId: testUserId,
      email: "synthetic-user@example.com",
      token: "wrong-mismatched-token",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1d")
      .sign(secretBytes);

    const result = await validateSessionToken(forgedJwt);
    expect(result).toBeNull();
  });

  it("rejects and purges expired database sessions", async () => {
    const expiredRawToken = "expired-token-val";
    const dbSession = await prisma.session.create({
      data: {
        userId: testUserId,
        tokenHash: hashToken(expiredRawToken),
        expiresAt: new Date(Date.now() - 5000),
      },
    });

    const secretBytes = new TextEncoder().encode(getEnv().AUTH_SECRET);
    const expiredJwt = await new SignJWT({
      sessionId: dbSession.id,
      userId: testUserId,
      email: "synthetic-user@example.com",
      token: expiredRawToken,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretBytes);

    const result = await validateSessionToken(expiredJwt);
    expect(result).toBeNull();

    const purgedSession = await prisma.session.findUnique({
      where: { id: dbSession.id },
    });
    expect(purgedSession).toBeNull();
  });

  it("invalidates a session on logout immediately so subsequent requests are rejected", async () => {
    const sessionJwt = await createSession(testUserId);
    const beforeLogout = await validateSessionToken(sessionJwt);
    expect(beforeLogout).not.toBeNull();

    await invalidateSession(sessionJwt);

    const afterLogout = await validateSessionToken(sessionJwt);
    expect(afterLogout).toBeNull();
  });

  // =========================================================================
  // 2. UNIT TESTS: CSRF & Origin / Referer Validation Rules
  // =========================================================================
  it("validates CSRF origin and host match correctly", () => {
    // Valid matching origin
    const validReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    expect(validateRequestOrigin(validReq)).toBe(true);

    // Mismatched cross-origin
    const crossOriginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://malicious-site.com" },
    });
    expect(validateRequestOrigin(crossOriginReq)).toBe(false);

    // Missing Origin but valid Referer
    const validRefererReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { host: "localhost:3000", referer: "http://localhost:3000/login" },
    });
    expect(validateRequestOrigin(validRefererReq)).toBe(true);

    // Missing Origin and mismatched Referer
    const badRefererReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { host: "localhost:3000", referer: "http://attacker.com/login" },
    });
    expect(validateRequestOrigin(badRefererReq)).toBe(false);

    // Missing both Origin and Referer when cookies are present -> MUST BE REJECTED
    const strippedHeadersCookieReq = new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: { host: "localhost:3000", cookie: "sonora_session=xyz" },
    });
    expect(validateRequestOrigin(strippedHeadersCookieReq)).toBe(false);

    // Safe GET request is always allowed regardless of Origin
    const getReq = new Request("http://localhost:3000/api/auth/me", {
      method: "GET",
      headers: { host: "localhost:3000", origin: "http://malicious-site.com" },
    });
    expect(validateRequestOrigin(getReq)).toBe(true);
  });

  // =========================================================================
  // 3. IN-PROCESS ROUTE HANDLER TESTS: Login, Logout, and Account Takeover Prevention
  // Note: These tests invoke the Next.js route handler functions directly with Request objects.
  // =========================================================================
  it("rejects state-changing GET requests on login and logout endpoints with 405", async () => {
    const loginRes = await loginGetHandler();
    expect(loginRes.status).toBe(405);

    const logoutRes = await logoutGetHandler();
    expect(logoutRes.status).toBe(405);
  });

  it("rejects cross-origin POST on login route with 403 Forbidden", async () => {
    const res = await loginHandler(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:3000",
          origin: "http://attacker-site.com",
        },
        body: JSON.stringify({ demoUser: true }),
      })
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("CSRF protection");
  });

  it("rejects cross-origin POST on logout route with 403 Forbidden", async () => {
    const res = await logoutHandler(
      new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://attacker-site.com",
        },
      })
    );
    expect(res.status).toBe(403);
  });

  // --- PASSWORDLESS ACCOUNT TAKEOVER REGRESSION TESTS ---
  it("regression: rejects arbitrary email from creating an account and receiving a session", async () => {
    const newRandomEmail = "unregistered-user-999@example.com";
    const res = await loginHandler(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ email: newRandomEmail }),
      })
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Passwordless email login is disabled");

    // Verify user was NOT created in database
    const createdUser = await prisma.user.findUnique({ where: { email: newRandomEmail } });
    expect(createdUser).toBeNull();
  });

  it("regression: rejects existing user email from being used to access their account", async () => {
    const res = await loginHandler(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ email: existingVictimEmail }),
      })
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Passwordless email login is disabled");

    // Verify NO sessions were created for the victim user
    const victimSessions = await prisma.session.findMany({ where: { userId: victimUserId } });
    expect(victimSessions).toHaveLength(0);
  });

  it("regression: rejects submitting synthetic email in email form from bypassing demo restrictions", async () => {
    const res = await loginHandler(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ email: "synthetic-user@example.com" }),
      })
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Passwordless email login is disabled");
  });

  it("regression: rejects demo authentication when DEMO_AUTH_ENABLED is false", async () => {
    const envObj = process.env as Record<string, string | undefined>;
    const origNodeEnv = envObj.NODE_ENV;
    const origDemoAuth = envObj.DEMO_AUTH_ENABLED;

    try {
      envObj.NODE_ENV = "development";
      envObj.DEMO_AUTH_ENABLED = "false";

      const res = await loginHandler(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:3000",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ demoUser: true }),
        })
      );

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("disabled");
    } finally {
      envObj.NODE_ENV = origNodeEnv;
      envObj.DEMO_AUTH_ENABLED = origDemoAuth;
    }
  });

  it("regression: rejects demo authentication in production even if DEMO_AUTH_ENABLED is true", async () => {
    const envObj = process.env as Record<string, string | undefined>;
    const origNodeEnv = envObj.NODE_ENV;
    const origDemoAuth = envObj.DEMO_AUTH_ENABLED;
    const origKey = envObj.TOKEN_ENCRYPTION_KEY;

    try {
      envObj.NODE_ENV = "production";
      envObj.DEMO_AUTH_ENABLED = "true";
      envObj.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const res = await loginHandler(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:3000",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ demoUser: true }),
        })
      );

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("disabled");
    } finally {
      envObj.NODE_ENV = origNodeEnv;
      envObj.DEMO_AUTH_ENABLED = origDemoAuth;
      envObj.TOKEN_ENCRYPTION_KEY = origKey;
    }
  });

  it("regression: permits demo authentication only when both NODE_ENV=development and DEMO_AUTH_ENABLED=true", async () => {
    const envObj = process.env as Record<string, string | undefined>;
    const origNodeEnv = envObj.NODE_ENV;
    const origDemoAuth = envObj.DEMO_AUTH_ENABLED;

    try {
      envObj.NODE_ENV = "development";
      envObj.DEMO_AUTH_ENABLED = "true";

      const res = await loginHandler(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:3000",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ demoUser: true }),
        })
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.user.email).toBe("synthetic-user@example.com");
    } finally {
      envObj.NODE_ENV = origNodeEnv;
      envObj.DEMO_AUTH_ENABLED = origDemoAuth;
    }
  });

  // =========================================================================
  // 4. IN-PROCESS ROUTE HANDLER TESTS: /api/auth/me Independent Enforcement
  // =========================================================================
  it("enforces authentication independently on /api/auth/me", async () => {
    const unauthReq = new Request("http://localhost:3000/api/auth/me", { method: "GET" });
    const unauthRes = await meHandler(unauthReq);
    expect(unauthRes.status).toBe(401);
    const json = await unauthRes.json();
    expect(json.authenticated).toBe(false);

    // Verify authorized access with valid session cookie
    const sessionJwt = await createSession(testUserId);
    const authReq = new Request("http://localhost:3000/api/auth/me", {
      method: "GET",
      headers: {
        cookie: `sonora_session=${sessionJwt}`,
      },
    });
    const authRes = await meHandler(authReq);
    expect(authRes.status).toBe(200);
    const authJson = await authRes.json();
    expect(authJson.authenticated).toBe(true);
    expect(authJson.user.email).toBe("synthetic-user@example.com");
  });
});
