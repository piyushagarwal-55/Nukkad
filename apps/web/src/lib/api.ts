export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * credentials:'include' on every call. The session is an httpOnly cookie set
 * by the API on :3000 while the app runs on :3001, so without this the
 * browser silently drops it and every authenticated route 401s.
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${path} -> ${res.status}`);
  return body as T;
}

export const get = <T,>(path: string) => req<T>(path, { cache: 'no-store' });
export const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) =>
  req<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T,>(path: string) => req<T>(path, { method: 'DELETE' });

/**
 * Rupees, showing paise only when there are any.
 *
 * This used to round everything to whole rupees, which is fine on a
 * dashboard and wrong on a bill review: 538.65 displayed as 539 and 179.55
 * as 180 makes the arithmetic look broken to anyone holding the paper, and
 * hides the discount that produced the odd number in the first place.
 */
export const rupees = (paise: number) => {
  const exact = paise % 100 === 0;
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: exact ? 0 : 2,
    maximumFractionDigits: exact ? 0 : 2,
  }).format(paise / 100);
};

export interface Me {
  kiranaId: string;
  shopName: string;
  ownerName: string | null;
  whatsappNumber: string | null;
  wabaStatus: string;
  counts: { skus: number; households: number; orders: number };
}
