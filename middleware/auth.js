import jwt from 'jsonwebtoken';
import User from '../models/User.js';
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
