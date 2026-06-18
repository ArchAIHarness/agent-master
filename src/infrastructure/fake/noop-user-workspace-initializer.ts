import type { UserWorkspaceInitializer } from "../../ports/user-workspace-initializer";

export class NoopUserWorkspaceInitializer implements UserWorkspaceInitializer {
  async initialize(): Promise<void> {
    // No-op for tests
  }

  async ensureDirectories(): Promise<void> {
    // No-op for tests
  }
}
