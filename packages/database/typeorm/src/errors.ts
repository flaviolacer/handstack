export class PersistenceConflictError extends Error {
  readonly code = 'persistence_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'PersistenceConflictError';
  }
}

export class PersistenceConcurrencyError extends Error {
  readonly code = 'persistence_concurrency_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'PersistenceConcurrencyError';
  }
}
