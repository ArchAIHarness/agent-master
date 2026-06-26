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
    webui: z.object({
      port: z.number().int().min(1).max(65_535),
    }),
    agent: z.object({
      port: z.number().int().min(1).max(65_535).default(4096),
    }),
    workdir: z.string().min(1),
    workspacePvcClaimName: z.string().min(1),
    workspacePvcSubPathRoot: z.string().min(1),
    resources: z.object({
      requests: z.object({
        cpu: z.string().min(1).default("100m"),
        memory: z.string().min(1).default("512Mi"),
      }).default({ cpu: "100m", memory: "512Mi" }),
      limits: z.object({
        cpu: z.string().min(1).default("500m"),
        memory: z.string().min(1).default("1Gi"),
      }).default({ cpu: "500m", memory: "1Gi" }),
    }).default({ requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "500m", memory: "1Gi" } }),
  }),
  init: z.object({
    templatesRoot: z.string().min(1),
  }),
  proxy: z.object({
    subdomainPort: z.number().int().min(1).max(65_535).default(8080),
    agentPathPort: z.number().int().min(1).max(65_535).default(4096),
  }).default({ subdomainPort: 8080, agentPathPort: 4096 }),
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
  let deepNested = "";

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
      deepNested = "";
      root[section] = {};
      continue;
    }

    if (indent === 2 && line.endsWith(":")) {
      nested = line.slice(0, -1);
      deepNested = "";
      const target = ensureRecord(root, section);
      target[nested] = {};
      continue;
    }

    if (indent === 2) {
      nested = "";
      deepNested = "";
      assignKeyValue(ensureRecord(root, section), line);
      continue;
    }

    if (indent === 4 && line.endsWith(":")) {
      deepNested = line.slice(0, -1);
      const target = ensureRecord(ensureRecord(root, section), nested);
      target[deepNested] = {};
      continue;
    }

    if (indent === 4 && nested) {
      assignKeyValue(ensureRecord(ensureRecord(root, section), nested), line);
    }

    if (indent === 6 && deepNested && nested) {
      assignKeyValue(ensureRecord(ensureRecord(ensureRecord(root, section), nested), deepNested), line);
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
