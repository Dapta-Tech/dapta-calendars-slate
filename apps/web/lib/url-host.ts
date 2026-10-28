/** The host of a URL with its port (`example.com:8443`), or the text itself when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
