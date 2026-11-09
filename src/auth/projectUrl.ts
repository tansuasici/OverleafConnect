import * as fs from 'fs';
import * as path from 'path';
import { stripCredentials } from './credentialHelper';

/** Written into a project folder on clone or configure; already listed in the folder's .gitignore. */
export const MARKER_FILE = '.overleafconnect';

export interface Marker {
  projectUrl: string;
  configured?: boolean;
}

/**
 * Turns a project ID, an Overleaf project page URL or a Git URL into the project's Git URL.
 * Examples:
 *   "682abc123def"
 *   "https://www.overleaf.com/project/682abc123def"
 *   "https://git.overleaf.com/682abc123def"
 */
export function resolveProjectUrl(input: string, serverUrl: string): string | null {
  const trimmed = input.trim();
  const server = serverUrl.replace(/\/$/, '');

  // A project page (checked first: it also ends in the hex ID, like a Git URL does).
  const webMatch = trimmed.match(/overleaf\.com\/project\/([a-f0-9]+)/i);
  if (webMatch) {
    return `${server}/${webMatch[1]}`;
  }

  if (/^https:\/\/.+\/[a-f0-9]+$/i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-f0-9]+$/i.test(trimmed)) {
    return `${server}/${trimmed}`;
  }

  return null;
}

/** The project's Git URL from a folder's origin remote, without any credentials it carries. */
export function projectUrlFromRemote(originUrl: string | undefined): string | undefined {
  const trimmed = originUrl?.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  return stripCredentials(trimmed).replace(/\/$/, '');
}

export function readMarker(folderPath: string): Marker | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(folderPath, MARKER_FILE), 'utf8'));
    return typeof data?.projectUrl === 'string' && data.projectUrl ? data : undefined;
  } catch {
    return undefined;
  }
}

export function writeMarker(folderPath: string, projectUrl: string): void {
  const marker: Marker = { ...readMarker(folderPath), projectUrl, configured: true };
  fs.writeFileSync(path.join(folderPath, MARKER_FILE), JSON.stringify(marker, null, 2));
}

export interface ProjectUrlSources {
  marker?: Marker;
  originUrl?: string;
  /** The single project URL older versions stored for every workspace. */
  legacyUrl?: string;
  /** The configured Git server, so self-hosted remotes are recognized. */
  serverUrl?: string;
}

export interface ResolvedProjectUrl {
  url: string;
  source: 'marker' | 'origin' | 'legacy';
}

/**
 * Picks the project a folder syncs with: its marker, else its origin remote. The old global URL
 * counts only when the folder's origin points at that same project, so a folder that is some other
 * repository never inherits it.
 */
export function pickProjectUrl(sources: ProjectUrlSources): ResolvedProjectUrl | undefined {
  if (sources.marker?.projectUrl) {
    return { url: sources.marker.projectUrl, source: 'marker' };
  }
  const fromOrigin = projectUrlFromRemote(sources.originUrl);
  const legacy = sources.legacyUrl?.replace(/\/$/, '');
  if (fromOrigin && legacy && sameProject(fromOrigin, legacy)) {
    return { url: legacy, source: 'legacy' };
  }
  if (fromOrigin && isOverleafGitUrl(fromOrigin, sources.serverUrl)) {
    return { url: fromOrigin, source: 'origin' };
  }
  return undefined;
}

export function sameProject(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Only remotes that look like an Overleaf Git bridge project, so unrelated repositories are left alone. */
export function isOverleafGitUrl(url: string, serverUrl = 'https://git.overleaf.com'): boolean {
  try {
    const u = new URL(url);
    const server = new URL(serverUrl);
    return (u.host === server.host || /(^|\.)overleaf\.com$/i.test(u.host)) && /^\/[a-f0-9]{10,}\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** The project ID at the end of a Git bridge URL. */
export function projectIdFromUrl(url: string): string | undefined {
  return url.match(/\/([a-f0-9]{10,})\/?$/i)?.[1];
}

function normalize(url: string): string {
  return stripCredentials(url).replace(/\/$/, '').toLowerCase();
}
