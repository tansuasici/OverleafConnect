export function buildAuthenticatedUrl(remoteUrl: string, username: string, token: string): string {
  const url = new URL(remoteUrl);
  url.username = username;
  url.password = token;
  return url.toString();
}

export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
