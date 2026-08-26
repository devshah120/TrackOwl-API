// The role model. Every user carries exactly one role; a role expands to a set
// of `resource:action` grants that the route layer checks with
// `requirePermission`.
//
// Two roles are structural rather than functional:
//   super_admin   — the platform operator. Not scoped to any account; every
//                   check short-circuits to allow, and the /api/admin routes
//                   are gated to this role alone.
//   company_admin — the account owner. Everything they create is owned by
//                   themselves, and every other user in the account points at
//                   them via `User.account`.
//
// The rest are staff seats inside one account: they share the admin's data but
// see a narrower slice of it.
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  COMPANY_ADMIN: 'company_admin',
  FLEET_MANAGER: 'fleet_manager',
  ACCOUNTANT: 'accountant',
  VIEWER: 'viewer',
  DRIVER: 'driver'
};

export const ROLE_VALUES = Object.values(ROLES);

// Roles a company_admin may hand out. They cannot mint another super_admin
// (platform-level) and cannot create a second company_admin — an account has
// exactly one owner, which keeps `User.account` a single unambiguous hop.
export const ASSIGNABLE_ROLES = [
  ROLES.FLEET_MANAGER,
  ROLES.ACCOUNTANT,
  ROLES.VIEWER,
  ROLES.DRIVER
];

// Human labels for the UI and for error messages.
export const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.COMPANY_ADMIN]: 'Company Admin',
  [ROLES.FLEET_MANAGER]: 'Fleet Manager',
  [ROLES.ACCOUNTANT]: 'Accountant',
  [ROLES.VIEWER]: 'Viewer',
  [ROLES.DRIVER]: 'Driver'
};

// The resources permissions are expressed over. These match the route groups,
// not the Mongoose models — `trips` covers both planned trips and the billing
// trips that carry the paperwork, because no role has been asked to hold one
// without the other.
export const RESOURCES = [
  'users',      // the team roster in Settings → User Management
  'company',    // the company master (name, GSTIN, logo, signature)
  'trucks',
  'drivers',
  'trips',
  'billing',
  'ledger',
  'tracking',   // devices, live positions, share links, history
  'reports'
];

// Actions, coarsest first. `manage` is the write-plus-destroy grant; a role
// holding it implicitly holds read.
export const ACTIONS = ['read', 'create', 'update', 'delete', 'manage'];

// The two roles whose grants are fixed in code. They are the way back in when a
// matrix edit goes wrong: if a Super Admin could strip their own access, or a
// Company Admin lose the roster, there would be no seat left able to reach the
// editor and undo it. The matrix editor refuses to touch these.
export const LOCKED_ROLES = [ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN];

// The roles a Super Admin may redefine — everything except the two above.
export const EDITABLE_ROLES = ROLE_VALUES.filter((r) => !LOCKED_ROLES.includes(r));

// The shipped defaults. These seed the RolePermission collection on first run
// and are the fallback whenever a role has no stored row, so the platform
// behaves identically to the hardcoded version until someone edits it.
//
// `*` is a wildcard in either half: '*:read' is read on every resource,
// 'trucks:*' is every action on trucks, '*:*' is everything.
export const DEFAULT_GRANTS = {
  [ROLES.SUPER_ADMIN]: ['*:*'],

  // The account owner. Full control of their own account, including the roster.
  [ROLES.COMPANY_ADMIN]: ['*:*'],

  // Runs the fleet day to day: vehicles, drivers, trips and tracking are theirs
  // to change. They can see costs (a trip's fuel spend is operational) but not
  // edit the books, and they cannot invoice.
  [ROLES.FLEET_MANAGER]: [
    'trucks:*',
    'drivers:*',
    'trips:*',
    'tracking:*',
    'ledger:read',
    'ledger:create',
    'billing:read',
    'company:read',
    'reports:read',
    'users:read'
  ],

  // Owns the money: the ledger and the billing/invoice side. Reads the
  // operational data those numbers hang off, but does not dispatch.
  [ROLES.ACCOUNTANT]: [
    'ledger:*',
    'billing:*',
    'trips:read',
    'trucks:read',
    'drivers:read',
    'company:read',
    'reports:read',
    'users:read'
  ],

  // Read-only across the account. The seat for an auditor or a customer-side
  // observer.
  [ROLES.VIEWER]: ['*:read'],

  // A driver's own app-side view: the trips assigned to them and where their
  // vehicle is. Deliberately narrow — no ledger, no roster, no fleet edits.
  [ROLES.DRIVER]: [
    'trips:read',
    'tracking:read',
    'trucks:read'
  ]
};

// Grants loaded from the database, keyed by role. Populated by
// `loadRolePermissions` at boot and refreshed whenever the matrix is saved.
//
// Held in memory because `hasPermission` runs on every guarded request — a
// database read per check would put a round trip in front of every API call.
// The matrix changes rarely and only through one route, so the cache only has
// to be invalidated there.
let overrides = {};

// Replaces the cached matrix. Called by the loader at boot and by the save
// route; nothing else should write to it.
export const setRolePermissions = (byRole) => {
  overrides = { ...byRole };
};

// What the cache currently holds — for the API to return and for tests.
export const getRolePermissions = () => ({ ...overrides });

// Expands a role into its grant list.
//
// Resolution order: locked roles always answer from code, so no stored row can
// weaken them; otherwise a stored override wins, and the shipped default is the
// fallback. An unknown role gets nothing rather than throwing, so a row left
// behind by an old migration fails closed.
export const grantsFor = (role) => {
  if (LOCKED_ROLES.includes(role)) return DEFAULT_GRANTS[role] || [];
  return overrides[role] || DEFAULT_GRANTS[role] || [];
};

// Is this a grant string the matrix editor will accept? Guards against a
// hand-crafted payload storing something `hasPermission` would never match, or
// a resource that does not exist.
export const isValidGrant = (grant) => {
  if (typeof grant !== 'string') return false;
  const parts = grant.split(':');
  if (parts.length !== 2) return false;
  const [resource, action] = parts;
  if (resource !== '*' && !RESOURCES.includes(resource)) return false;
  if (action !== '*' && !ACTIONS.includes(action)) return false;
  return true;
};

// Does `role` hold `resource:action`?
//
// A grant matches when both halves match, where `*` on either side of the
// stored grant matches anything, and `manage` on the stored grant satisfies
// every action (manage implies read/create/update/delete).
export const hasPermission = (role, resource, action) => {
  const grants = grantsFor(role);

  return grants.some((grant) => {
    const [grantResource, grantAction] = grant.split(':');
    if (grantResource !== '*' && grantResource !== resource) return false;
    if (grantAction === '*' || grantAction === 'manage') return true;
    return grantAction === action;
  });
};

// Two grant lists mean the same thing when they permit exactly the same set of
// resource/action pairs. Compared this way rather than textually because the
// matrix editor stores what the ticks say — saving Viewer untouched turns the
// compact '*:read' into nine explicit grants, which is the same permission set
// and must not be reported as a customisation.
export const sameEffectiveGrants = (a = [], b = []) => {
  const effective = (grants) => {
    const out = [];
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        if (action === 'manage') continue;
        const held = grants.some((grant) => {
          const [gr, ga] = grant.split(':');
          if (gr !== '*' && gr !== resource) return false;
          return ga === '*' || ga === 'manage' || ga === action;
        });
        if (held) out.push(`${resource}:${action}`);
      }
    }
    return out.join(',');
  };
  return effective(a) === effective(b);
};

// The flat grant list handed to the frontend on login, so the UI can hide what
// the API would refuse anyway. Wildcards are expanded here rather than in the
// browser — the client should never have to re-implement the matcher.
export const expandGrants = (role) => {
  const expanded = new Set();

  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      if (action === 'manage') continue;
      if (hasPermission(role, resource, action)) expanded.add(`${resource}:${action}`);
    }
  }

  return [...expanded];
};
