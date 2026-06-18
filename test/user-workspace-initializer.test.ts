import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { FileSystemUserWorkspaceInitializer } from "../src/infrastructure/file-system-user-workspace-initializer";

describe("FileSystemUserWorkspaceInitializer", () => {
  test("creates template files without overwriting existing user files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-master-workspace-"));
    const templatesRoot = join(root, "templates");
    const workspaceRoot = join(root, "users", "user-a");
    const initializer = new FileSystemUserWorkspaceInitializer();

    await mkdir(join(templatesRoot, ".opencode"), { recursive: true });
    await writeFile(join(templatesRoot, "AGENTS.md"), "default agents", { flag: "wx" });
    await writeFile(join(templatesRoot, ".opencode", "opencode.json"), "{}", { flag: "wx" });

    await initializer.initialize(workspaceRoot, templatesRoot);
    await writeFile(join(workspaceRoot, "runtime", "AGENTS.md"), "user customized");
    await initializer.initialize(workspaceRoot, templatesRoot);

    await expect(readFile(join(workspaceRoot, "runtime", "AGENTS.md"), "utf8")).resolves.toBe("user customized");
  });

  test("uses exclusive file creation for template writes", async () => {
    const source = await readFile("src/infrastructure/file-system-user-workspace-initializer.ts", "utf8");

    expect(source).toContain('flag: "wx"');
    expect(source).not.toContain("existsSync(destPath)");
  });
});
