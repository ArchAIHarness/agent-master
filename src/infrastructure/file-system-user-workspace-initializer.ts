import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { UserWorkspaceInitializer } from "../ports/user-workspace-initializer";

export class FileSystemUserWorkspaceInitializer implements UserWorkspaceInitializer {
  async initialize(workspaceRoot: string, templatesRoot: string): Promise<void> {
    // 1. Create all required directories
    // Directory structure per user:
    // - {workspaceRoot}/ → /app (user workdir)
    // - {workspaceRoot}/.opencode/ → /app/.opencode
    // - {workspaceRoot}/.runtime/opencode/config → /root/.config/opencode (OpenCode config)
    // - {workspaceRoot}/.runtime/opencode/data → /root/.local/share/opencode (OpenCode data/auth)
    // - {workspaceRoot}/.runtime/opencode/cache → /root/.cache/opencode (OpenCode cache/providers/plugins)
    await this.ensureDir(workspaceRoot);
    await this.ensureDir(`${workspaceRoot}/.opencode`);
    await this.ensureDir(`${workspaceRoot}/.runtime/opencode/config`);
    await this.ensureDir(`${workspaceRoot}/.runtime/opencode/data`);
    await this.ensureDir(`${workspaceRoot}/.runtime/opencode/cache`);

    // 2. Copy default templates only if files do NOT exist (atomic, never overwrite user files)
    // - {templatesRoot}/AGENTS.md → {workspaceRoot}/AGENTS.md
    await this.copyIfNotExists(`${templatesRoot}/AGENTS.md`, `${workspaceRoot}/AGENTS.md`);
    // - {templatesRoot}/opencode.json → {workspaceRoot}/.opencode/opencode.json
    await this.copyIfNotExists(`${templatesRoot}/opencode.json`, `${workspaceRoot}/.opencode/opencode.json`);
  }

  private async ensureDir(dir: string): Promise<void> {
    if (existsSync(dir)) {
      return;
    }
    await mkdir(dir, { recursive: true });
  }

  private async copyIfNotExists(srcPath: string, destPath: string): Promise<void> {
    if (existsSync(destPath)) {
      // File already exists (user modified), skip to avoid overwriting
      return;
    }
    if (!existsSync(srcPath)) {
      // Template file not exist, skip (optional template)
      return;
    }
    // Read template and write atomically
    const content = await readFile(srcPath);
    await writeFile(destPath, content);
  }
}
