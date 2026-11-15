// Add site's guess at what a site is built on, from its home page: WordPress's paths
// (wp-content, wp-json) or its generator tag mean WordPress; anything else reads as static. An
// app is never guessed: Tyler picks it. The page is fetched as the icon fetch fetches it.
import type { DetectPlatformResponse, Platform } from '@kamaji/shared';
import { get, MAX_PAGE_BYTES, type FetchOptions } from './icons.js';

const WORDPRESS = [
  /wp-content\//i,
  /wp-json/i,
  /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i,
  /<meta[^>]+content=["']WordPress[^>]+name=["']generator["']/i,
];

export function platformOf(html: string): Platform {
  return WORDPRESS.some((p) => p.test(html)) ? 'wordpress' : 'static';
}

export async function detectPlatform(
  url: string,
  options: FetchOptions = {},
): Promise<DetectPlatformResponse> {
  const site = new URL(url);
  const page = await get(site, site, 'text/html', MAX_PAGE_BYTES, 'cut', options);
  if (!page.ok) return { platform: null, problem: page.problem };
  return { platform: platformOf(new TextDecoder().decode(page.bytes)), problem: null };
}
