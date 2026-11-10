import { getDomain } from 'tldts';

// Where the password may be typed: exactly one of the item's websites.
export function isItemWebsite(url: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes(new URL(url).origin);
}

// Where the browser may land after signing in: an item website, or another host
// under the same registrable domain (a venue subdomain, say). Private suffixes such
// as github.io count as public, so unrelated a.github.io and b.github.io never match.
export function isSameSiteAsItemWebsite(url: string, allowedOrigins: string[]): boolean {
  if (isItemWebsite(url, allowedOrigins)) return true;
  const landing = new URL(url);
  const landingDomain = registrableDomain(landing.hostname);
  if (!landingDomain) return false;
  return allowedOrigins.some((origin) => {
    const allowed = new URL(origin);
    return allowed.protocol === landing.protocol && allowed.port === landing.port && registrableDomain(allowed.hostname) === landingDomain;
  });
}

function registrableDomain(hostname: string): string | null {
  return getDomain(hostname, { allowPrivateDomains: true });
}
