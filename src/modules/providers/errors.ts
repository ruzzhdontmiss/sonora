import { DomainError } from "../common/errors";

export class ProviderError extends DomainError {
  public readonly provider: string;

  constructor(provider: string, message: string) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  public readonly missingConfig: string[];

  constructor(provider: string, missingConfig: string[]) {
    super(
      provider,
      `Provider credentials not configured. Missing environment variables: ${missingConfig.join(
        ", "
      )}.`
    );
    this.name = "ProviderNotConfiguredError";
    this.missingConfig = missingConfig;
  }
}

export class OAuthStateValidationError extends ProviderError {
  constructor(provider: string, reason: string) {
    super(provider, `OAuth state validation failed: ${reason}`);
    this.name = "OAuthStateValidationError";
  }
}

export class OAuthTokenExchangeError extends ProviderError {
  public readonly statusCode?: number;

  constructor(provider: string, message: string, statusCode?: number) {
    super(provider, `Token exchange failed: ${message}`);
    this.name = "OAuthTokenExchangeError";
    this.statusCode = statusCode;
  }
}

export class TokenRefreshError extends ProviderError {
  public readonly isRevoked: boolean;

  constructor(provider: string, message: string, isRevoked: boolean = false) {
    super(provider, `Token refresh failed: ${message}`);
    this.name = "TokenRefreshError";
    this.isRevoked = isRevoked;
  }
}

export class ProviderRateLimitError extends ProviderError {
  public readonly retryAfterSeconds: number;

  constructor(provider: string, retryAfterSeconds: number) {
    super(
      provider,
      `Rate limit exceeded. Retry allowed after ${retryAfterSeconds} seconds.`
    );
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderAuthenticationError extends ProviderError {
  constructor(provider: string, message: string = "Provider authentication failed or token expired.") {
    super(provider, message);
    this.name = "ProviderAuthenticationError";
  }
}

export class ProviderQuotaExhaustedError extends ProviderError {
  public readonly quotaBucket: "GENERAL" | "SEARCH";
  public readonly limit: number;
  public readonly requested: number;
  public readonly remaining: number;
  public readonly resetsAt: Date;
  public readonly projectId?: string;

  constructor(params: {
    provider: string;
    quotaBucket: "GENERAL" | "SEARCH";
    limit: number;
    requested: number;
    remaining: number;
    resetsAt: Date;
    projectId?: string;
  }) {
    super(
      params.provider,
      `Daily ${params.quotaBucket} quota exhausted for Google Cloud project${
        params.projectId ? ` "${params.projectId}"` : ""
      }. Limit: ${params.limit}, Requested: ${params.requested}, Remaining: ${
        params.remaining
      }. Quota resets at midnight Pacific Time (${params.resetsAt.toISOString()}).`
    );
    this.name = "ProviderQuotaExhaustedError";
    this.quotaBucket = params.quotaBucket;
    this.limit = params.limit;
    this.requested = params.requested;
    this.remaining = params.remaining;
    this.resetsAt = params.resetsAt;
    this.projectId = params.projectId;
  }
}

