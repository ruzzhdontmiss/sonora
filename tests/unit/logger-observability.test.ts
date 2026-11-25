import { describe, it, expect, vi } from "vitest";
import {
  redactSensitiveData,
  logInfo,
  logWarn,
  logError,
} from "@/lib/logger";

describe("Observability & Redacted Structured Logging (P5-T09)", () => {
  it("redacts sensitive fields like tokens, secrets, codes, and passwords", () => {
    const input = {
      userId: "user-123",
      operation: "youtube.import",
      accessToken: "ya29.sensitive-google-access-token",
      refreshToken: "1//04sensitive-refresh-token",
      clientSecret: "GOCSPX-supersecret",
      code: "4/0Aean-auth-code",
      password: "userpassword",
      quotaConsumed: 50,
      durationMs: 120,
    };

    const redacted = redactSensitiveData(input) as Record<string, unknown>;

    expect(redacted["userId"]).toBe("user-123");
    expect(redacted["operation"]).toBe("youtube.import");
    expect(redacted["quotaConsumed"]).toBe(50);
    expect(redacted["durationMs"]).toBe(120);

    expect(redacted["accessToken"]).toBe("[REDACTED]");
    expect(redacted["refreshToken"]).toBe("[REDACTED]");
    expect(redacted["clientSecret"]).toBe("[REDACTED]");
    expect(redacted["code"]).toBe("[REDACTED]");
    expect(redacted["password"]).toBe("[REDACTED]");
  });

  it("redacts Bearer token substrings inside text values", () => {
    const rawString = "Authorization header: Bearer ya29.a0AfH6SMC...-xyz";
    const result = redactSensitiveData(rawString);
    expect(result).toBe("Authorization header: Bearer [REDACTED]");
  });

  it("handles nested structures and arrays gracefully", () => {
    const nested = {
      items: [
        { id: "item1", token: "secret-token-1" },
        { id: "item2", token: "secret-token-2" },
      ],
      config: {
        apiSecret: "my-secret",
        timeout: 5000,
      },
    };

    const redacted = redactSensitiveData(nested) as Record<string, unknown>;
    const items = redacted["items"] as Array<Record<string, unknown>>;
    const config = redacted["config"] as Record<string, unknown>;

    expect(items[0]["token"]).toBe("[REDACTED]");
    expect(items[1]["token"]).toBe("[REDACTED]");
    expect(items[0]["id"]).toBe("item1");
    expect(config["apiSecret"]).toBe("[REDACTED]");
    expect(config["timeout"]).toBe(5000);
  });

  it("formats structured JSON logs with context and timestamp", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logInfo(
      { module: "youtube-importer", operation: "importLibrary", userId: "u-1" },
      "Import completed",
      { importedTracks: 42, accessToken: "token-to-hide" }
    );

    expect(logSpy).toHaveBeenCalled();
    const loggedStr = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedStr);

    expect(parsed.level).toBe("INFO");
    expect(parsed.module).toBe("youtube-importer");
    expect(parsed.message).toBe("Import completed");
    expect(parsed.meta.importedTracks).toBe(42);
    expect(parsed.meta.accessToken).toBe("[REDACTED]");

    logSpy.mockRestore();
  });
});
