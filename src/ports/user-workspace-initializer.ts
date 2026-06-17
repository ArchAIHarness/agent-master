/**
 * User Workspace Initialization port.
 * - First creation: create directories + copy default templates (only if files not exist)
 * - Restart: only ensure directories exist, never overwrite user files
 */
export interface UserWorkspaceInitializer {
  /**
   * Initialize user workspace.
   * @param workspaceRoot absolute path to user workdir root
   * @param templatesRoot absolute path to default templates root
   *   - {templatesRoot}/AGENTS.md → {workspaceRoot}/AGENTS.md
   *   - {templatesRoot}/opencode.json → {workspaceRoot}/.opencode/opencode.json
   */
  initialize(workspaceRoot: string, templatesRoot: string): Promise<void>;
}
