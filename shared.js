/* Shared by the background page and settings UI. */
globalThis.RedirectLocal = (() => {
  function parseSettings(input) {
    const portText = String(input?.port ?? "").trim();
    if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
      throw new Error("Enter a localhost port between 1 and 65535.");
    }
    const value = String(input?.url ?? "").trim();
    if (!value) throw new Error("Enter the website URL to redirect.");
    let source;
    try {
      source = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw new Error("Enter a valid website URL, such as https://example.com.");
    }
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
      throw new Error("Use an HTTP or HTTPS URL without a username or password.");
    }
    if (["localhost", "127.0.0.1", "[::1]"].includes(source.hostname) || source.hostname.endsWith(".localhost")) {
      throw new Error("Enter a remote website, not localhost.");
    }
    return { port: Number(portText), url: source.origin };
  }

  function redirectTarget(requestUrl, settings) {
    if (!settings) return null;
    const request = new URL(requestUrl);
    const source = new URL(settings.url);
    if (!["http:", "https:"].includes(request.protocol) || request.host !== source.host) return null;
    return `http://localhost:${settings.port}${request.pathname}${request.search}${request.hash}`;
  }

  return { parseSettings, redirectTarget };
})();
