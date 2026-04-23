export class EASStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EASStoreError";
  }
}

export class ConfigurationError extends EASStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export class VerificationError extends EASStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationError";
  }
}
