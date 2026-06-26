import type { UserWorkspaceInitializer } from "../../domain/runtime/user-workspace-initializer";

export class NoopUserWorkspaceInitializer implements UserWorkspaceInitializer {
  async initialize(): Promise<void> {
    // No-op for tests
  }

  async ensureDirectories(): Promise<void> {
    // No-op for tests
  }
}
