/**
 * Minimal, dependency-free Builder.io API client for the autosave contract
 * test harness. Mirrors the real write path in
 * `templates/content/actions/_builder-cms-write-client.ts` and the reference
 * Fusion repo (`server/routes/builder.ts`):
 *
 *   - Write API:   https://builder.io/api/v1/write/{model}[/{id}]
 *                  Authorization: Bearer {privateKey}
 *   - Delivery:    https://cdn.builder.io/api/v3/content/{model}[/{id}]?apiKey={publicKey}
 *
 * Hosts are overridable via BUILDER_CONTENT_API_HOST / BUILDER_CMS_API_HOST so
 * the harness can be pointed at a mock or a staging space.
 *
 * Every call returns a CapturedExchange: the exact request (URL with the
 * private key redacted, method, redacted headers, body) and the raw response
 * (status, headers, parsed/raw body). That captured evidence is what the
 * findings doc is built from — not documentation.
 */

export interface CapturedExchange {
  label: string;
  request: {
    method: string;
    url: string; // private key already redacted
    headers: Record<string, string>; // authorization redacted
    body: unknown;
  };
  response: {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
  };
  durationMs: number;
  capturedAt: string;
}

export interface BuilderClientConfig {
  privateKey: string | undefined;
  publicKey: string | undefined;
  writeHost: string;
  cdnHost: string;
}

const SENSITIVE_QUERY_KEYS = new Set(["apiKey", "key"]);

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key)) {
        url.searchParams.set(key, "<REDACTED>");
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = key.toLowerCase() === "authorization" ? "Bearer <REDACTED>" : value;
  }
  return out;
}

function responseHeadersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function resolveConfig(): BuilderClientConfig {
  const writeHost = (
    process.env.BUILDER_CONTENT_API_HOST ??
    process.env.BUILDER_CMS_API_HOST ??
    "https://builder.io"
  ).replace(/\/+$/, "");
  const cdnHost = (
    process.env.BUILDER_CDN_HOST ?? "https://cdn.builder.io"
  ).replace(/\/+$/, "");
  return {
    privateKey:
      process.env.BUILDER_PRIVATE_KEY ?? process.env.BUILDER_CMS_PRIVATE_KEY,
    publicKey: process.env.BUILDER_API_KEY ?? process.env.BUILDER_PUBLIC_KEY,
    writeHost,
    cdnHost,
  };
}

export class BuilderContractClient {
  private readonly config: BuilderClientConfig;
  readonly exchanges: CapturedExchange[] = [];

  constructor(config: BuilderClientConfig) {
    this.config = config;
  }

  hasWriteCredentials(): boolean {
    return Boolean(this.config.privateKey);
  }

  hasReadCredentials(): boolean {
    return Boolean(this.config.publicKey);
  }

  private async capture(args: {
    label: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }): Promise<CapturedExchange> {
    const startedAt = Date.now();
    const init: RequestInit = {
      method: args.method,
      headers: args.headers,
    };
    if (args.body !== undefined) {
      init.body = JSON.stringify(args.body);
    }
    const response = await fetch(args.url, init);
    const text = await response.text();
    const exchange: CapturedExchange = {
      label: args.label,
      request: {
        method: args.method,
        url: redactUrl(args.url),
        headers: redactHeaders(args.headers),
        body: args.body ?? null,
      },
      response: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersToObject(response.headers),
        body: parseBody(text),
      },
      durationMs: Date.now() - startedAt,
      capturedAt: new Date(startedAt).toISOString(),
    };
    this.exchanges.push(exchange);
    return exchange;
  }

  // ---- Write API (requires private key) ----

  private writeHeaders(): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.config.privateKey ?? ""}`,
      "content-type": "application/json",
    };
  }

  /** POST /api/v1/write/{model} — create a new entry. */
  async createEntry(args: {
    label: string;
    model: string;
    body: Record<string, unknown>;
  }): Promise<CapturedExchange> {
    const url = `${this.config.writeHost}/api/v1/write/${encodeURIComponent(args.model)}`;
    return this.capture({
      label: args.label,
      method: "POST",
      url,
      headers: this.writeHeaders(),
      body: args.body,
    });
  }

  /**
   * PATCH /api/v1/write/{model}/{id} — update an existing entry.
   *
   * `query` lets the caller toggle autoSaveOnly / triggerWebhooks exactly as
   * the production adapter does. Returns the captured exchange.
   */
  async patchEntry(args: {
    label: string;
    model: string;
    entryId: string;
    query?: Record<string, string>;
    body: Record<string, unknown>;
  }): Promise<CapturedExchange> {
    const url = new URL(
      `${this.config.writeHost}/api/v1/write/${encodeURIComponent(args.model)}/${encodeURIComponent(args.entryId)}`,
    );
    for (const [k, v] of Object.entries(args.query ?? {})) {
      url.searchParams.set(k, v);
    }
    return this.capture({
      label: args.label,
      method: "PATCH",
      url: url.toString(),
      headers: this.writeHeaders(),
      body: args.body,
    });
  }

  // ---- Delivery / read API (requires public key) ----

  /**
   * GET https://cdn.builder.io/api/v3/content/{model}/{id}
   *
   * Without includeUnpublished this returns the LIVE delivered artifact (what
   * a site visitor sees). With includeUnpublished=true it also returns drafts.
   * cachebust defeats the delivery cache so we read current state.
   */
  async getDeliveredEntry(args: {
    label: string;
    model: string;
    entryId: string;
    includeUnpublished?: boolean;
    cachebust?: boolean;
  }): Promise<CapturedExchange> {
    const url = new URL(
      `${this.config.cdnHost}/api/v3/content/${encodeURIComponent(args.model)}/${encodeURIComponent(args.entryId)}`,
    );
    url.searchParams.set("apiKey", this.config.publicKey ?? "");
    if (args.includeUnpublished) url.searchParams.set("includeUnpublished", "true");
    if (args.cachebust) url.searchParams.set("cachebust", String(Date.now()));
    return this.capture({
      label: args.label,
      method: "GET",
      url: url.toString(),
      headers: { accept: "application/json" },
    });
  }

  /**
   * GET https://cdn.builder.io/api/v3/content/{model}?query.id={id}
   * Used to characterize duplicate-handle resolution and listing semantics.
   */
  async queryEntries(args: {
    label: string;
    model: string;
    query?: Record<string, string>;
    includeUnpublished?: boolean;
    limit?: number;
  }): Promise<CapturedExchange> {
    const url = new URL(
      `${this.config.cdnHost}/api/v3/content/${encodeURIComponent(args.model)}`,
    );
    url.searchParams.set("apiKey", this.config.publicKey ?? "");
    if (args.includeUnpublished) url.searchParams.set("includeUnpublished", "true");
    if (typeof args.limit === "number") url.searchParams.set("limit", String(args.limit));
    url.searchParams.set("cachebust", String(Date.now()));
    for (const [k, v] of Object.entries(args.query ?? {})) {
      url.searchParams.set(k, v);
    }
    return this.capture({
      label: args.label,
      method: "GET",
      url: url.toString(),
      headers: { accept: "application/json" },
    });
  }
}
