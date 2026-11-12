import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getEnv } from "@/config/env";
import { SESSION_COOKIE_NAME } from "./constants";

export { SESSION_COOKIE_NAME };

const SESSION_MAX_AGE_DAYS = 7;

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function getAuthSecretBytes(): Uint8Array {
  const secret = getEnv().AUTH_SECRET;
  return new TextEncoder().encode(secret);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionPayload {
  sessionId: string;
  userId: string;
  email: string;
  token: string;
}

export interface AuthContext {
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  session: {
    id: string;
    expiresAt: Date;
  };
}

/**
 * Creates a new session in database and returns a signed JWT cookie value.
 * Stores SHA-256 token hash in database and includes the raw token in the signed JWT payload.
 */
export async function createSession(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error("User not found for session creation");
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  const dbSession = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  const jwt = await new SignJWT({
    sessionId: dbSession.id,
    userId: user.id,
    email: user.email,
    token: rawToken,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_DAYS}d`)
    .sign(getAuthSecretBytes());

  return jwt;
}

/**
 * Validates a signed JWT session cookie against database state.
 * Strictly verifies:
 * 1. JWT signature with AUTH_SECRET
 * 2. JWT expiration claim
 * 3. Database session existence
 * 4. Token hash cryptographic binding
 * 5. Database session expiration
 */
export async function validateSessionToken(tokenString: string): Promise<AuthContext | null> {
  try {
    const { payload } = await jwtVerify(tokenString, getAuthSecretBytes(), {
      algorithms: ["HS256"],
    });

    const sessionId = payload.sessionId as string;
    const userId = payload.userId as string;
    const rawToken = payload.token as string;

    if (!sessionId || !userId || !rawToken) {
      return null;
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
          },
        },
      },
    });

    if (!session) return null;

    // Cryptographic hash check: ensure token in signed JWT matches database tokenHash
    if (hashToken(rawToken) !== session.tokenHash) {
      return null;
    }

    // Database expiration check
    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
      return null;
    }

    return {
      user: session.user,
      session: {
        id: session.id,
        expiresAt: session.expiresAt,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Helper to fetch session for the current incoming server request.
 * Can inspect a passed Request object or fall back to Next.js cookies().
 */
export async function getCurrentSession(request?: Request): Promise<AuthContext | null> {
  let sessionCookie: string | undefined;

  if (request) {
    const cookieHeader = request.headers.get("cookie");
    if (cookieHeader) {
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]*)`));
      sessionCookie = match ? decodeURIComponent(match[1]) : undefined;
    }
  }

  if (!sessionCookie) {
    try {
      const cookieStore = await cookies();
      sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    } catch {
      return null;
    }
  }

  if (!sessionCookie) return null;
  return validateSessionToken(sessionCookie);
}

/**
 * Enforces authentication on server actions or routes; throws UnauthorizedError if missing.
 */
export async function requireAuth(request?: Request): Promise<AuthContext> {
  const sessionContext = await getCurrentSession(request);
  if (!sessionContext) {
    throw new UnauthorizedError("Authentication required");
  }
  return sessionContext;
}

/**
 * Invalidates current session in the database immediately.
 */
export async function invalidateSession(tokenString: string): Promise<void> {
  try {
    const { payload } = await jwtVerify(tokenString, getAuthSecretBytes(), {
      algorithms: ["HS256"],
    });
    const sessionId = payload.sessionId as string;
    if (sessionId) {
      await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    }
  } catch {
    // Ignore verification failure on logout
  }
}
