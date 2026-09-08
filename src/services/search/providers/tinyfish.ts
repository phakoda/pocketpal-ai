import type {SearchHit, SearchOptions, SearchProvider} from '../types';

const ENDPOINT = 'https://api.search.tinyfish.ai';
const MAX_RESPONSE_CHARS = 256 * 1024;

/** Fail closed on non-web URLs, userinfo, oversized URLs and local addresses. */
export function safeSearchUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      !host.includes('.') ||
      host.startsWith('[') ||
      /^(0|10|127|169\.254|192\.168)\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return undefined;
    }
    // Existing read_url URL allowlisting and network validation still apply.
    return url.href;
  } catch {
    return undefined;
  }
}

export function parseTinyFishResults(
  value: unknown,
  maxResults: number,
): SearchHit[] {
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 8) {
    throw new Error('TinyFish result count must be between 1 and 8.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as {results?: unknown}).results)
  ) {
    throw new Error('TinyFish returned an invalid search response.');
  }
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const item of (value as {results: unknown[]}).results.slice(0, 100)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const url = safeSearchUrl(row.url);
    if (
      !url ||
      seen.has(url) ||
      typeof row.title !== 'string' ||
      typeof row.snippet !== 'string'
    ) {
      continue;
    }
    seen.add(url);
    hits.push({
      url,
      title: row.title.slice(0, 300),
      snippet: row.snippet.slice(0, 2000),
    });
    if (hits.length === maxResults) {
      break;
    }
  }
  return hits;
}

/** Direct TinyFish Search API. Monid's advertised keyless product is a separate route. */
export class TinyFishProvider implements SearchProvider {
  readonly id = 'tinyfish' as const;
  constructor(
    private getKey: () => string,
    private request: typeof fetch = fetch,
  ) {}

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    if (
      !Number.isSafeInteger(options.maxResults) ||
      options.maxResults < 1 ||
      options.maxResults > 8
    ) {
      throw new Error('TinyFish result count must be between 1 and 8.');
    }
    const text = query.trim();
    if (!text || text.length > 500) {
      throw new Error('TinyFish query must contain 1 to 500 characters.');
    }
    const key = this.getKey().trim();
    if (!key || /[\r\n]/.test(key)) {
      throw new Error(
        'TinyFish (direct API) requires a TinyFish API key. This is not the keyless Monid service advertised in the linked article.',
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.request(
        `${ENDPOINT}?query=${encodeURIComponent(text)}`,
        {
          method: 'GET',
          headers: {'X-API-Key': key, Accept: 'application/json'},
          signal: controller.signal,
          // Do not forward the API credential to a redirected host.
          redirect: 'error',
        },
      );
      if (!response.ok) {
        throw new Error(`TinyFish search failed (HTTP ${response.status}).`);
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_RESPONSE_CHARS) {
        throw new Error('TinyFish response was too large.');
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_CHARS) {
        throw new Error('TinyFish response was too large.');
      }
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error('TinyFish returned invalid JSON.');
      }
      return parseTinyFishResults(data, options.maxResults);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('TinyFish search timed out.');
      }
      // Do not echo provider response bodies, keys, or low-level request dumps.
      if (error instanceof Error && error.message.startsWith('TinyFish ')) {
        throw error;
      }
      throw new Error(
        'TinyFish search could not complete. Check your connection and API key.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
