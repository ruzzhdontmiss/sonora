import { z } from "zod";

/**
 * Server-side environment schema.
 * All sensitive credentials must remain server-side only (never prefixed with NEXT_PUBLIC_).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://127.0.0.1:3000"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters long"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().url().optional().default("redis://localhost:6379"),
  TOKEN_ENCRYPTION_KEY: z.string().min(16, "TOKEN_ENCRYPTION_KEY is required"),
  DEMO_AUTH_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
  // Optional provider credentials for subsequent phases
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  SPOTIFY_REDIRECT_URI: z.string().url().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_MUSIC_KEY_ID: z.string().optional(),
  APPLE_MUSIC_PRIVATE_KEY_PATH: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === "production") {
    // In production, enforce 256 bits of cryptographic entropy (64 hex characters)
    if (!/^[0-9a-fA-F]{64}$/.test(data.TOKEN_ENCRYPTION_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "In production, TOKEN_ENCRYPTION_KEY must be a 64-character hex string (256 bits, e.g. generated via 'openssl rand -hex 32'). Human passphrases are not permitted in production.",
        path: ["TOKEN_ENCRYPTION_KEY"],
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export class ConfigurationError extends Error {
  public readonly missingVariables: string[];

  constructor(missingVariables: string[], message?: string) {
    super(
      message ||
        `Configuration validation failed. Missing or invalid variables: ${missingVariables.join(
          ", "
        )}. Never log or expose secret values.`
    );
    this.name = "ConfigurationError";
    this.missingVariables = missingVariables;
  }
}

/**
 * Validates provided environment record or process.env safely.
 * Never prints or leaks secret values in error messages or logs.
 */
export function validateEnv(rawEnv: Record<string, string | undefined> = process.env): Env {
  // Guard against accidental NEXT_PUBLIC_ secret leaks
  const publicSecretLeaks = Object.keys(rawEnv).filter(
    (key) =>
      key.startsWith("NEXT_PUBLIC_") &&
      /(SECRET|PASSWORD|PRIVATE|TOKEN|KEY)/i.test(key)
  );

  if (publicSecretLeaks.length > 0) {
    throw new ConfigurationError(
      publicSecretLeaks,
      `Security violation: Server secrets detected with NEXT_PUBLIC_ prefix: ${publicSecretLeaks.join(
        ", "
      )}`
    );
  }

  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const invalidFields = result.error.issues.map((issue) => issue.path.join("."));
    const uniqueFields = Array.from(new Set(invalidFields));
    throw new ConfigurationError(
      uniqueFields,
      `Environment configuration error for variable(s): ${uniqueFields.join(
        ", "
      )}. Review .env.example for required names.`
    );
  }

  return result.data;
}

// Lazy cached instance for production runtime
let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (process.env.NODE_ENV !== "production") {
    return validateEnv(process.env);
  }
  if (!cachedEnv) {
    cachedEnv = validateEnv(process.env);
  }
  return cachedEnv;
}
