export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * credentials:'include' on every call. The session is an httpOnly cookie set
 * by the API on :3000 while the app runs on :3001, so without this the
 * browser silently drops it and every authenticated route 401s.
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${path} -> ${res.status}`);
  return body as T;
}

export const get = <T,>(path: string) => req<T>(path, { cache: 'no-store' });
export const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
export const patch = <T,>(path: string, body: unknown) =>
  req<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const rupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(paise / 100);

export interface Me {
  kiranaId: string;
  shopName: string;
  ownerName: string | null;
  whatsappNumber: string | null;
  wabaStatus: string;
  counts: { skus: number; households: number; orders: number };
}
