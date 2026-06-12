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
    timeout: z.number().int().positive(),
    port: z.number().int().min(1).max(65_535),
    workdir: z.string().min(1),
    scenes: z.record(z.string().min(1), z.string().min(1)),
  }),
  nas: z.object({
    path: z.string().min(1),
  }),
  kubernetes: z.object({
    cluster: z.string().min(1),
    namespace: z.string().min(1),
    clusters: z.array(
      z.object({
        name: z.string().min(1),
        namespace: z.string().min(1),
        auth: z.string().min(1),
        scheduling: z.object({
          enabled: z.boolean(),
          maxRuntime: z.number().int().positive(),
        }),
      }),
    ),
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
  let currentCluster: Record<string, unknown> | null = null;

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
      root[section] = section === "kubernetes" ? { clusters: [] } : {};
      continue;
    }

    if (indent === 2 && line.endsWith(":")) {
      nested = line.slice(0, -1);
      const target = ensureRecord(root, section);
      target[nested] = nested === "clusters" ? [] : {};
      continue;
    }

    if (section === "kubernetes" && nested === "clusters" && indent === 4 && line.startsWith("- ")) {
      currentCluster = {};
      const clusters = ensureArray(ensureRecord(root, section), "clusters");
      clusters.push(currentCluster);
      assignKeyValue(currentCluster, line.slice(2));
      continue;
    }

    if (section === "kubernetes" && nested === "clusters" && currentCluster && indent === 6) {
      if (line.endsWith(":")) {
        const key = line.slice(0, -1);
        currentCluster[key] = {};
        nested = `clusters.${key}`;
      } else {
        assignKeyValue(currentCluster, line);
      }
      continue;
    }

    if (section === "kubernetes" && nested === "clusters.scheduling" && currentCluster && indent === 8) {
      const scheduling = ensureRecord(currentCluster, "scheduling");
      assignKeyValue(scheduling, line);
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

function ensureArray(target: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = target[key];
  if (Array.isArray(value)) {
    return value as Array<Record<string, unknown>>;
  }
  const array: Array<Record<string, unknown>> = [];
  target[key] = array;
  return array;
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
