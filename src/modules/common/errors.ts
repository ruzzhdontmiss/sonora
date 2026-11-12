export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, identifier?: string) {
    super(`${resource}${identifier ? ` (${identifier})` : ""} was not found.`);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string = "Access denied. You do not have permission to access this resource.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string = "Authentication is required to perform this action.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends DomainError {
  public readonly errors?: Record<string, string[]>;

  constructor(message: string, errors?: Record<string, string[]>) {
    super(message);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export class UnsupportedOperationError extends DomainError {
  public readonly provider: string;
  public readonly operation: string;

  constructor(provider: string, operation: string, reason?: string) {
    super(
      `Operation "${operation}" is unsupported by provider "${provider}"${
        reason ? `: ${reason}` : "."
      }`
    );
    this.name = "UnsupportedOperationError";
    this.provider = provider;
    this.operation = operation;
  }
}

