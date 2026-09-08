import type {
  PageContent,
  SearchProvider,
  SearchHit,
  SearchOptions,
} from '../types';
import {fetchJson, requireKey} from './http';

type TinyFishResult = {
  position?: number;
  site_name?: string;
  title?: string;
  snippet?: string;
  url?: string;
};

type TinyFishSearchResponse = {
  results?: TinyFishResult[];
  total_results?: number;
  page?: number;
};

type TinyFishFetchResponse = {
  results?: Array<{
    url?: string;
    title?: string;
    format?: string;
    text?: string;
  }>;
  errors?: unknown[];
};

export class TinyFishProvider implements SearchProvider {
  readonly id = 'tinyfish' as const;

  constructor(private getKey: () => string) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const key = requireKey(this.getKey(), 'TinyFish');
    const endpoint = `https://api.search.tinyfish.ai?query=${encodeURIComponent(
      query,
    )}`;
    const data = await fetchJson<TinyFishSearchResponse>(endpoint, {
      method: 'GET',
      headers: {'X-API-Key': key},
    });

    return (data.results ?? [])
      .slice(0, opts.maxResults)
      .map(result => ({
        title: result.title ?? result.site_name ?? '',
        url: result.url ?? '',
        snippet: result.snippet ?? '',
      }))
      .filter(hit => hit.url.length > 0);
  }

  async read(url: string): Promise<PageContent> {
    const key = requireKey(this.getKey(), 'TinyFish');
    const data = await fetchJson<TinyFishFetchResponse>(
      'https://api.fetch.tinyfish.ai',
      {
        method: 'POST',
        headers: {
          'X-API-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({urls: [url]}),
      },
    );
    const result = data.results?.[0];
    if (!result?.text) {
      throw new Error('TinyFish returned no page content');
    }
    return {
      url: result.url ?? url,
      title: result.title,
      text: result.text,
    };
  }
}
