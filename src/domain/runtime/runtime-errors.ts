export class RuntimeDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingUserIdError extends RuntimeDomainError {
  constructor() {
    super("x-user-id is required");
  }
}

export class RuntimeNotFoundError extends RuntimeDomainError {
  constructor(userId: string) {
    super(`runtime for user ${userId} was not found`);
  }
}

export class RuntimeNotRunningError extends RuntimeDomainError {
  constructor(runtimeId: string) {
    super(`runtime ${runtimeId} is not running`);
  }
}

export class UnknownRuntimeSceneError extends RuntimeDomainError {
  constructor(scene: string) {
    super(`runtime scene ${scene} is not configured`);
  }
}
