/**
 * Party-supplied URLs. Only an http(s) URL that the URL parser accepts
 * becomes a link; it opens in a new tab without referrer or opener access and
 * is visibly marked as external. Anything else is shown as plain text.
 */
export function safeHttpUrl(value: string): URL | null {
  if (/\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export function ExternalLink({ href }: { href: string }) {
  const url = safeHttpUrl(href);
  if (url === null) return <span className="pre-wrap break">{href}</span>;
  return (
    <a className="external-link break" href={url.href} target="_blank" rel="noopener noreferrer nofollow">
      {href}
      <span className="external-link__marker"> (external link, opens in a new tab)</span>
    </a>
  );
}
