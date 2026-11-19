// Hosts the screenshot browser never loads (ops/screenshots-plan.md; Tyler, 2026-11-19): analytics,
// ads and session recording, so a shot doesn't count as a visit in a client's statistics. Each
// matches the host and anything under it. HubSpot's tracking only: never js.hsforms.net or
// forms.hsforms.com, since Briardale's forms must still render.
export const BLOCKED_HOSTS: readonly string[] = [
  // Google
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  // Meta
  'connect.facebook.net',
  // Hotjar
  'hotjar.com',
  'hotjar.io',
  // Microsoft
  'clarity.ms',
  'bat.bing.com',
  // HubSpot: tracking, cookie banner and chat only
  'js.hs-analytics.net',
  'js.hs-scripts.com',
  'track.hubspot.com',
  'js.hs-banner.com',
  'js.usemessages.com',
  // LinkedIn
  'snap.licdn.com',
  'px.ads.linkedin.com',
  // TikTok
  'analytics.tiktok.com',
];
