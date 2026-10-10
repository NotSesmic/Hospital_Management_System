// Small client for the hospital API (server.js). In development the CRA dev
// server proxies /api to http://localhost:4000 (see "proxy" in package.json).

const SESSION_KEY = 'hospital-session';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const session = {
  load() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  },
  save(value) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  },
  clear() {
    sessionStorage.removeItem(SESSION_KEY);
  },
};

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const token = session.load()?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the hospital server. Is "npm run api" running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/signin')) onUnauthorized();
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return data;
}

const qs = (params) => new URLSearchParams(params).toString();

export const api = {
  signUp: (name, email, password) => request('POST', '/auth/signup', { name, email, password }),
  signIn: (email, password) => request('POST', '/auth/signin', { email, password }),
  signOut: () => request('POST', '/auth/signout'),
  me: () => request('GET', '/auth/me'),

  meta: () => request('GET', '/meta'),
  dashboard: () => request('GET', '/dashboard'),
  discharges: (from, to) => request('GET', `/discharges?${qs({ from, to })}`),
  suggest: (q) => request('GET', `/search/suggest?${qs({ q })}`),
  search: (q) => request('GET', `/search?${qs({ q })}`),

  registerPatient: (patient) => request('POST', '/patients', patient),
  allocateNext: () => request('POST', '/allocations/next'),
  allocateBulk: (count) => request('POST', '/allocations/bulk', { count }),
  discharge: (id) => request('POST', `/admissions/${id}/discharge`),
  addArrivals: (count) => request('POST', '/simulation/arrivals', { count }),
  tick: (inflow) => request('POST', '/simulation/tick', { inflow }),
  importDemo: () => request('POST', '/demo/import', { bootstrap: true }),
};
