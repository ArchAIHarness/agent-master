import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { UserWorkspaceInitializer } from "../domain/runtime/user-workspace-initializer";

export class FileSystemUserWorkspaceInitializer implements UserWorkspaceInitializer {
  async initialize(workspaceRoot: string, templatesRoot: string): Promise<void> {
    // 1. Create all required directories (top-level design: runtime + global split)
    // Directory structure per user on NAS:
    // - {workspaceRoot}/                  → root for this user
    // - {workspaceRoot}/runtime/          → subPath mounted to container /app (user project workspace)
    //   - {workspaceRoot}/runtime/AGENTS.md          → /app/AGENTS.md (default project rules from template)
    //   - {workspaceRoot}/runtime/.opencode/opencode.json → /app/.opencode/opencode.json (default opencode config from template)
    // - {workspaceRoot}/global/           → subPath mounted to container /root (matches opencode default home directory structure)
    //   - {workspaceRoot}/global/.config/opencode     → /root/.config/opencode (opencode global config)
    //   - {workspaceRoot}/global/.local/share/opencode → /root/.local/share/opencode (opencode global data/auth.json)
    //   - {workspaceRoot}/global/.cache/opencode     → /root/.cache/opencode (opencode cache/providers/plugins)
    await this.ensureDirectories(workspaceRoot);

    // 2. Copy default templates only if files do NOT exist (atomic, never overwrite user files)
    // - {templatesRoot}/AGENTS.md → {workspaceRoot}/runtime/AGENTS.md
    await this.copyIfNotExists(`${templatesRoot}/AGENTS.md`, `${workspaceRoot}/runtime/AGENTS.md`);
    // - {templatesRoot}/.opencode/opencode.json → {workspaceRoot}/runtime/.opencode/opencode.json
    await this.copyIfNotExists(`${templatesRoot}/.opencode/opencode.json`, `${workspaceRoot}/runtime/.opencode/opencode.json`);
  }

  async ensureDirectories(workspaceRoot: string): Promise<void> {
    await this.ensureDir(workspaceRoot);
    await this.ensureDir(`${workspaceRoot}/runtime`);
    await this.ensureDir(`${workspaceRoot}/runtime/.opencode`);
    await this.ensureDir(`${workspaceRoot}/global/.config/opencode`);
    await this.ensureDir(`${workspaceRoot}/global/.local/share/opencode`);
    await this.ensureDir(`${workspaceRoot}/global/.cache/opencode`);
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async copyIfNotExists(srcPath: string, destPath: string): Promise<void> {
    let content: Buffer;
    try {
      content = await readFile(srcPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        console.warn(`Template file ${srcPath} not found, skipping initialization`);
        return;
      }
      throw new Error(`Failed to read template ${srcPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await writeFile(destPath, content, { flag: "wx" });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return;
      }
      throw new Error(`Failed to copy template from ${srcPath} to ${destPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
