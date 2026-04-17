/**
 * Centralized API client for MyAURA.
 *
 * All backend calls MUST go through apiFetch so that the Telegram initData
 * signature is attached to every request. The server validates this
 * signature and derives a trusted telegramId from it.
 *
 * NEVER send telegramId in request body/query for identity purposes —
 * the server will ignore client-provided identity when INIT_DATA_STRICT=true.
 */

function getInitData(): string | null {
  try {
    const tg = (window as any).Telegram?.WebApp;
    return tg?.initData || null;
  } catch {
    return null;
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const initData = getInitData();
  const headers = new Headers(init.headers || {});
  if (initData) {
    headers.set("x-telegram-init-data", initData);
  }
  return fetch(input, { ...init, headers });
}

export async function apiJson<T = any>(input: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  const res = await apiFetch(input, { ...init, headers });
  if (!res.ok) {
    let details: any = null;
    try { details = await res.json(); } catch { /* ignore */ }
    const err: any = new Error(details?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.details = details;
    throw err;
  }
  return res.json();
}
