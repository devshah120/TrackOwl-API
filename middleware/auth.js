import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Driver from '../models/Driver.js';
import { ROLES, hasPermission } from '../utils/permissions.js';

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
