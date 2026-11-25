/* Shared by the background page and settings UI. */
globalThis.RedirectLocal = (() => {
  const CARRY_KEYS = ["cookies", "localStorage", "sessionStorage"];
  // The extension adds this to its own temporary tab so that tab is never redirected.
  const CARRY_PARAM = "__redirect_to_local_carry";

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
    const carry = {};
    for (const key of CARRY_KEYS) carry[key] = input?.carry?.[key] === true;
    return { port: Number(portText), url: source.origin, carry, warn: input?.warn === true };
  }

  function redirectTarget(requestUrl, settings) {
    if (!settings) return null;
    const request = new URL(requestUrl);
    const source = new URL(settings.url);
    if (!["http:", "https:"].includes(request.protocol) || request.host !== source.host) return null;
    if (request.searchParams.has(CARRY_PARAM)) return null;
    return `http://localhost:${settings.port}${request.pathname}${request.search}${request.hash}`;
  }

  function hasCarry(carry) {
    return CARRY_KEYS.some((key) => carry?.[key] === true);
  }

  // Cookies use the localhost host only. Secure and SameSite=None cannot apply to HTTP.
  function toLocalCookie(cookie, port) {
    const details = {
      url: `http://localhost:${port}/`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      httpOnly: cookie.httpOnly === true
    };
    if (cookie.sameSite === "lax" || cookie.sameSite === "strict") details.sameSite = cookie.sameSite;
    if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    return details;
  }

  return { CARRY_KEYS, CARRY_PARAM, parseSettings, redirectTarget, hasCarry, toLocalCookie };
})();
