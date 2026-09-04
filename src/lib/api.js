// Seam for switching the app from its bundled sample dataset to the live
// backend once it's deployed (see xenvia-backend/DEPLOY.md). Not wired into
// App.jsx yet by design — the first Android build should work with zero
// external dependencies, so it's guaranteed to run even before the backend
// is live. Flip DEVICE_SOURCE once you've deployed and tested the API.

export const DEVICE_SOURCE = 'bundled'; // 'bundled' | 'api'
export const API_BASE_URL = 'https://your-backend-domain.example.com'; // set after deploying (see DEPLOY.md)

export async function fetchDevicesFromApi(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE_URL}/api/devices${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.devices; // already shaped to match the frontend's device model — see backend README
}

export async function fetchDeviceByIdFromApi(id) {
  const res = await fetch(`${API_BASE_URL}/api/devices/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

/*
To actually switch App.jsx over to live data once the backend is deployed:
  1. Set API_BASE_URL above to your real deployed URL, and DEVICE_SOURCE to 'api'.
  2. In App.jsx, replace:
       const MASTER_DEVICES = useMemo(() => buildCatalog(RAW_DEVICES), []);
     with a small effect that calls fetchDevicesFromApi() into a useState,
     with a loading state shown on the startup screen while it resolves,
     and a fallback to buildCatalog(RAW_DEVICES) if the fetch fails (so a
     backend outage degrades to sample data instead of a blank app).
  This is a small, mechanical change — the shapes already match — but it's
  a real code change, not a config toggle, so it's left as an explicit next
  step rather than half-wired in now.
*/
