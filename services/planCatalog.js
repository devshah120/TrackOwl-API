// What a plan can include. Each module is a real part of the app: a plan that
// does not include a module has that module's API refused (middleware/auth.js)
// and its menu entries hidden. The Super Admin ticks modules per plan; nothing
// here is display-only.
//
// The always-included core (dashboard, vehicles, drivers, customers, users,
// company settings, notifications, billing) is not listed — no plan can be
// sold without it.
//
// `prefixes` are API path prefixes the module owns; `patterns` are regexes for
// routes nested under another module's prefix. The most specific match wins,
// so the driver app's expense endpoint belongs to `driver_app` even though it
// sits under /api/trip-orders.

export const PLAN_MODULES = [
  { key: 'gps_tracking', label: 'Real-time GPS tracking', group: 'Tracking', prefixes: ['/api/track', '/api/trips'] },
  { key: 'trip_history', label: 'Route history & replay', group: 'Tracking', prefixes: ['/api/history'] },
  { key: 'alerts_geofence', label: 'GPS alerts & geofencing', group: 'Tracking', prefixes: ['/api/alerts'] },
  { key: 'tracking_links', label: 'Customer tracking links', group: 'Tracking', prefixes: ['/api/track/tokens'] },
  { key: 'trip_management', label: 'Trip management, POD & settlement', group: 'Trips', prefixes: ['/api/trip-orders'] },
  { key: 'lr_documents', label: 'LR & document printing', group: 'Trips', prefixes: ['/api/billing-trips'] },
  { key: 'driver_app', label: 'Driver mobile app', group: 'Trips', patterns: [/^\/api\/trip-orders\/[^/]+\/driver-expenses/] },
  { key: 'gst_invoicing', label: 'GST invoices & payment tracking', group: 'Money', prefixes: ['/api/invoices'] },
  { key: 'finance', label: 'Finance, P&L, vendors & daily ledger', group: 'Money', prefixes: ['/api/finance', '/api/vendors', '/api/ledger'] },
  { key: 'fuel', label: 'Fuel management & mileage', group: 'Fleet', prefixes: ['/api/fuel'] },
  { key: 'maintenance', label: 'Maintenance, tyres & batteries', group: 'Fleet', prefixes: ['/api/maintenance', '/api/components'] },
  { key: 'reports', label: 'Reports with Excel & PDF export', group: 'Insight', prefixes: ['/api/reports'] },
  { key: 'integrations', label: 'Integrations (webhooks)', group: 'Insight', prefixes: ['/api/integrations'] }
];

export const ALL_MODULE_KEYS = PLAN_MODULES.map((m) => m.key);
export const MODULE_LABELS = Object.fromEntries(PLAN_MODULES.map((m) => [m.key, m.label]));

// Paths that sit under a module's prefix but belong to the core: the main
// dashboard reads /api/finance/dashboard for its trip and fleet blocks too
// (it leaves out the money figures itself when finance is not in the plan),
// and public tracking pages are opened by a customer's customer, not a seat.
const CORE_PATHS = ['/api/finance/dashboard', '/api/track/public', '/api/trips/public'];

/** Which module an API request belongs to, or null for the core. */
export const moduleForPath = (url = '') => {
  const path = String(url).split('?')[0];
  if (CORE_PATHS.some((p) => path.startsWith(p))) return null;
  for (const m of PLAN_MODULES) {
    if (m.patterns?.some((re) => re.test(path))) return m.key;
  }
  let best = null;
  let bestLength = 0;
  for (const m of PLAN_MODULES) {
    for (const prefix of m.prefixes || []) {
      if ((path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) && prefix.length > bestLength) {
        best = m.key;
        bestLength = prefix.length;
      }
    }
  }
  return best;
};

export const cleanModules = (list) => [...new Set((Array.isArray(list) ? list : []).filter((k) => ALL_MODULE_KEYS.includes(k)))];

const limitLine = (n, one, many) => (n ? `Up to ${n.toLocaleString('en-IN')} ${n === 1 ? one : many}` : `Unlimited ${many}`);

/**
 * The lines shown under a plan on the pricing and billing pages, built from
 * what the plan actually is — its limits and its modules — plus any extra
 * lines the Super Admin added (support level and the like). Change the limit
 * or untick a module and this changes with it.
 */
export const displayFeatures = (plan = {}) => {
  const modules = Array.isArray(plan.modules) ? plan.modules : ALL_MODULE_KEYS;
  return [
    limitLine(plan.maxVehicles, 'vehicle', 'vehicles'),
    limitLine(plan.maxUsers, 'user', 'users'),
    ...PLAN_MODULES.filter((m) => modules.includes(m.key)).map((m) => m.label),
    ...(plan.extraFeatures || [])
  ];
};
