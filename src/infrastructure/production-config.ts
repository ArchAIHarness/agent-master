import { z } from "zod";

const productionConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65_535),
    host: z.string().min(1),
    log: z.string().min(1),
  }),
  redis: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    db: z.number().int().min(0),
    key: z.string().min(1),
    password: z.string().default(""),
  }),
  runtime: z.object({
    image: z.string().min(1),
    ttl: z.number().int().positive(),
    port: z.number().int().min(1).max(65_535),
    workdir: z.string().min(1),
    workspacePvcClaimName: z.string().min(1),
    workspacePvcSubPathRoot: z.string().min(1),
  }),
  init: z.object({
    templatesRoot: z.string().min(1),
  }),
  kubernetes: z.object({
    cluster: z.string().min(1),
    namespace: z.string().min(1),
  }),
});

export type ProductionConfig = z.infer<typeof productionConfigSchema>;

export async function loadProductionConfig(path = "config.yaml"): Promise<ProductionConfig> {
  const content = await Bun.file(path).text();
  return parseProductionConfig(content);
}

export function parseProductionConfig(content: string): ProductionConfig {
  const parsed = parseYamlSubset(content);
  return productionConfigSchema.parse(parsed);
}

function parseYamlSubset(content: string): unknown {
  const root: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let section = "";
  let nested = "";

  for (const rawLine of lines) {
    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = rawLine.search(/\S/);
    const line = withoutComment.trim();

    if (indent === 0 && line.endsWith(":")) {
      section = line.slice(0, -1);
      nested = "";
      root[section] = {};
      continue;
    }

    if (indent === 2 && line.endsWith(":")) {
      nested = line.slice(0, -1);
      const target = ensureRecord(root, section);
      target[nested] = {};
      continue;
    }

    if (indent === 2) {
      nested = "";
      assignKeyValue(ensureRecord(root, section), line);
      continue;
    }

    if (indent === 4 && nested) {
      assignKeyValue(ensureRecord(ensureRecord(root, section), nested), line);
    }
  }

  return root;
}

function stripComment(line: string): string {
  const index = line.indexOf("#");
  return index >= 0 ? line.slice(0, index) : line;
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = target[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const record: Record<string, unknown> = {};
  target[key] = record;
  return record;
}

function assignKeyValue(target: Record<string, unknown>, line: string): void {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return;
  }
  const key = line.slice(0, separator).trim();
  const rawValue = line.slice(separator + 1).trim();
  target[key] = parseScalar(rawValue);
}

function parseScalar(value: string): unknown {
  if (value === "\"\"" || value === "''") {
    return "";
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
