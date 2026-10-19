/**
 * Test helpers: a routing fetch mock that records every request.
 */

export interface RecordedCall {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

type Route = (call: RecordedCall) => Response | Promise<Response>;

export function jsonResponse(body: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const PROFILES = {
  data: [
    { customer_profile_id: 7728503, network_type: "twitter", name: "Fireworks", groups: [2837214] },
    { customer_profile_id: 7728506, network_type: "linkedin_company", name: "Fireworks AI", groups: [2837214] },
    { customer_profile_id: 7738019, network_type: "youtube", name: "Kodie Dower", groups: [2837214] },
  ],
};

/**
 * Install a fetch mock. Routes are matched in order by substring of
 * "METHOD url". Unmatched requests throw so tests fail loudly.
 */
export function mockFetch(routes: [string, Route][]) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    let body: any = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as string
      }
    }
    const call: RecordedCall = { url, method, body, headers: init.headers || {} };
    calls.push(call);
    for (const [key, route] of routes) {
      if (`${method} ${url}`.includes(key)) {
        return route(call);
      }
    }
    throw new Error(`Unmocked request: ${method} ${url}`);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
