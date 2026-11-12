import { describe, it, expect } from "vitest";
import { validateEnv, ConfigurationError } from "@/config/env";

describe("Environment Configuration Validation (P1-T04)", () => {
  const validEnv = {
    NODE_ENV: "test",
    APP_URL: "http://127.0.0.1:3000",
    AUTH_SECRET: "test-auth-secret-super-secure-key-1234",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/sonora_test",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key-32bytes!",
  };

  it("successfully parses valid environment variables and defaults DEMO_AUTH_ENABLED to false", () => {
    const parsed = validateEnv(validEnv);
    expect(parsed.AUTH_SECRET).toBe(validEnv.AUTH_SECRET);
    expect(parsed.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(parsed.NODE_ENV).toBe("test");
    expect(parsed.DEMO_AUTH_ENABLED).toBe(false);
  });

  it("parses DEMO_AUTH_ENABLED=true correctly", () => {
    const parsed = validateEnv({
      ...validEnv,
      DEMO_AUTH_ENABLED: "true",
    });
    expect(parsed.DEMO_AUTH_ENABLED).toBe(true);
  });

  it("fails fast with variable names only when required variables are missing", () => {
    const incompleteEnv = {
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1:3000",
    };

    try {
      validateEnv(incompleteEnv);
      expect.fail("Should have thrown ConfigurationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      const confErr = err as ConfigurationError;
      expect(confErr.missingVariables).toContain("AUTH_SECRET");
      expect(confErr.missingVariables).toContain("DATABASE_URL");
      expect(confErr.missingVariables).toContain("TOKEN_ENCRYPTION_KEY");
      // Ensure error message does not expose values
      expect(confErr.message).not.toContain("password");
    }
  });

  it("rejects NEXT_PUBLIC_ prefixes on secret variable names", () => {
    const unsafeKey = ["NEXT", "PUBLIC", "SPOTIFY", "SECRET"].join("_");
    const unsafeEnv = {
      ...validEnv,
      [unsafeKey]: "unsafe-placeholder",
    };

    expect(() => validateEnv(unsafeEnv)).toThrow(ConfigurationError);
    try {
      validateEnv(unsafeEnv);
    } catch (err) {
      const confErr = err as ConfigurationError;
      expect(confErr.message).toContain(unsafeKey);
      expect(confErr.message).not.toContain("unsafe-placeholder");
    }
  });
});
