import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Driver from '../models/Driver.js';
import { accessFor } from '../services/subscriptions.js';
import { moduleForPath, MODULE_LABELS } from '../services/planCatalog.js';
import { ROLES, hasPermission } from '../utils/permissions.js';

// Routes an account with an expired plan can still reach.
const BILLING_ALLOWLIST = ['/api/auth', '/api/user', '/api/subscription', '/api/plans', '/api/notifications'];

export const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // A seat can be switched off without deleting it. Checked here rather than
    // only at login so revoking access takes effect on the next request instead
    // of whenever the user's 7-day token happens to expire.
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Account is inactive'
      });
    }

    // A staff seat is deactivated implicitly when its account owner is: the
    // whole team loses access with the account, not one login at a time.
    if (user.account) {
      const owner = await User.findById(user.account).select('isActive');
      if (!owner || !owner.isActive) {
        return res.status(403).json({
          success: false,
          error: 'Account is inactive'
        });
      }
    }

    req.user = user;
    // Whose data this request operates on. Every data route scopes by this
    // rather than by req.user._id, which is what makes an account's staff seats
    // share one set of trucks, trips and ledger entries.
    req.accountId = user.account || user._id;

    // A Driver seat sees only the trips it is driving. The seat is tied to its
    // Driver profile by mobile number — the one field both records require and
    // that identifies a person — so no extra linking step is needed when an
    // admin creates the login. With no matching profile the seat gets an id
    // that matches nothing, never "no filter".
    if (user.role === ROLES.DRIVER) {
      const profile = await Driver.findOne({ owner: req.accountId, mobile: user.mobile }).select('_id').lean();
      req.driverProfileId = profile?._id || new mongoose.Types.ObjectId();
    }

    // Plan & billing. An account whose trial and paid period (plus grace) are
    // over is blocked with 402, except for what it needs to get unblocked:
    // signing in, its profile, the billing pages, and the bell. GPS ingestion
    // does not pass through here, so tracking data keeps arriving and nothing
    // is lost while an account is unpaid. The Super Admin is never blocked.
    if (user.role !== ROLES.SUPER_ADMIN) {
      try {
        req.subscription = await accessFor(req.accountId);
      } catch (error) {
        // A billing lookup failure must not take the whole API down.
        console.error('[auth] subscription check failed:', error.message);
        req.subscription = null;
      }
      const path = req.originalUrl || '';
      const allowed = BILLING_ALLOWLIST.some((prefix) => path.startsWith(prefix));
      if (req.subscription?.blocked && !allowed) {
        return res.status(402).json({
          success: false,
          code: 'SUBSCRIPTION_REQUIRED',
          error:
            req.subscription.status === 'cancelled'
              ? 'This account has been suspended. Please contact TrackOwl support.'
              : 'Your plan has expired. Renew it under Settings → Plan & Billing to continue.',
          subscription: { status: req.subscription.status, endsAt: req.subscription.endsAt }
        });
      }

      // The plan's modules. A request into a module the plan does not
      // include is refused, whatever the seat's role allows — so unticking
      // a module on a plan takes it away from every subscriber at once.
      const module = moduleForPath(path);
      if (module && req.subscription && !req.subscription.modules?.includes(module)) {
        return res.status(403).json({
          success: false,
          code: 'PLAN_FEATURE',
          module,
          error: `${MODULE_LABELS[module]} is not included in your ${req.subscription.plan?.name || ''} plan. Upgrade under Settings → Plan & Billing.`.replace('  ', ' ')
        });
      }
    }
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token'
    });
  }
};

// Gate a route to the platform operator. Must run after `protect`, which sets
// req.user.
export const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({
      success: false,
      error: 'Superadmin access required'
    });
  }
  next();
};

// Gate a route to the account owner — the seat that may edit the company master
// and manage the roster.
export const requireCompanyAdmin = (req, res, next) => {
  const role = req.user?.role;
  if (role !== ROLES.COMPANY_ADMIN && role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({
      success: false,
      error: 'Company admin access required'
    });
  }
  next();
};

// Gate a route on a single `resource:action` grant from the role matrix.
// Must run after `protect`.
//
//   router.post('/', protect, requirePermission('trucks', 'create'), handler)
export const requirePermission = (resource, action) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  if (!hasPermission(req.user.role, resource, action)) {
    return res.status(403).json({
      success: false,
      error: `Your role does not permit this action (${resource}:${action})`
    });
  }

  next();
};

// Is this request from a Driver seat? Routes use it to narrow what a driver
// sees to their own assigned work.
export const isDriverSeat = (req) => req.user?.role === ROLES.DRIVER;

// The narrow "limited trip updates" grant from the brief: a Driver seat may
// record the things only the person on the truck can — start and end readings,
// stop arrivals, proof of delivery, photos and incidents — on a trip that is
// already scoped to them, without holding the general trips:update grant that
// would also let them rewrite the money and the route.
export const requireTripUpdateOrDriver = (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated' });
  if (hasPermission(req.user.role, 'trips', 'update') || isDriverSeat(req)) return next();
  return res.status(403).json({
    success: false,
    error: 'Your role does not permit this action (trips:update)'
  });
};
