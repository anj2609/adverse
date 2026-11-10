export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");
const ADMIN = `${API_URL}/api/v1/admin`;
const TOKEN_KEY = "adforge_token";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export const token = {
  get: () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const t = token.get();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (init.body && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch {
    throw new ApiError(0, "network", `Can't reach the AdForge server at ${API_URL}. Is the backend running?`);
  }
  if (res.status === 401 && t && !url.includes("/auth/login")) {
    token.clear();
    if (typeof window !== "undefined") window.location.href = "/login";
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

const qs = (params?: Record<string, any>) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, String(v)));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  login: (email: string, password: string) => request<any>(`${API_URL}/api/v1/auth/login`, { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => request<any>(`${API_URL}/api/v1/auth/me`),
  get: <T = any>(path: string, params?: Record<string, any>) => request<T>(`${ADMIN}${path}${qs(params)}`),
  post: <T = any>(path: string, body?: unknown) => request<T>(`${ADMIN}${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T = any>(path: string, body: unknown) => request<T>(`${ADMIN}${path}`, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T = any>(path: string, body: unknown) => request<T>(`${ADMIN}${path}`, { method: "PUT", body: JSON.stringify(body) }),
  del: <T = any>(path: string) => request<T>(`${ADMIN}${path}`, { method: "DELETE" }),
  upload: <T = any>(path: string, form: FormData, method = "POST") => request<T>(`${ADMIN}${path}`, { method, body: form }),
  /** Uploads a file and gets a file back (e.g. the app ready for ads), with the server's report header. */
  uploadForFile: async (path: string, form: FormData) => {
    const res = await fetch(`${ADMIN}${path}`, { method: "POST", body: form, headers: token.get() ? { Authorization: `Bearer ${token.get()}` } : {} })
      .catch(() => { throw new ApiError(0, "network", `Can't reach the AdForge server at ${API_URL}. Is the backend running?`); });
    if (!res.ok) {
      const e = (await res.json().catch(() => null))?.error;
      throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`, e?.details);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download.zip";
    const report = JSON.parse(res.headers.get("x-adforge-report") ?? "{}");
    return { blob: await res.blob(), name, report };
  },
};
