import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { UserWorkspaceInitializer } from "../ports/user-workspace-initializer";

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
    await this.ensureDir(workspaceRoot);
    await this.ensureDir(`${workspaceRoot}/runtime`);
    await this.ensureDir(`${workspaceRoot}/runtime/.opencode`);
    await this.ensureDir(`${workspaceRoot}/global/.config/opencode`);
    await this.ensureDir(`${workspaceRoot}/global/.local/share/opencode`);
    await this.ensureDir(`${workspaceRoot}/global/.cache/opencode`);

    // 2. Copy default templates only if files do NOT exist (atomic, never overwrite user files)
    // - {templatesRoot}/AGENTS.md → {workspaceRoot}/runtime/AGENTS.md
    await this.copyIfNotExists(`${templatesRoot}/AGENTS.md`, `${workspaceRoot}/runtime/AGENTS.md`);
    // - {templatesRoot}/.opencode/opencode.json → {workspaceRoot}/runtime/.opencode/opencode.json
    await this.copyIfNotExists(`${templatesRoot}/.opencode/opencode.json`, `${workspaceRoot}/runtime/.opencode/opencode.json`);
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      if (existsSync(dir)) {
        return;
      }
      await mkdir(dir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async copyIfNotExists(srcPath: string, destPath: string): Promise<void> {
    try {
      if (existsSync(destPath)) {
        // File already exists (user modified), skip to avoid overwriting
        return;
      }
      if (!existsSync(srcPath)) {
        // Template file not exist, skip (optional template)
        console.warn(`Template file ${srcPath} not found, skipping initialization`);
        return;
      }
      // Read template and write atomically
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
    } catch (error) {
      throw new Error(`Failed to copy template from ${srcPath} to ${destPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
