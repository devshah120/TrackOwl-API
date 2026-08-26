import Company from '../models/Company.js';

// The generated documents were written against the User profile, which is
// where company details used to live. The Company master now owns them, so
// this flattens a Company back into the shape `drawLorryReceipt` and friends
// already read — letting the master feed the paperwork without every layout
// having to learn a second schema.
//
// Fields the master does not carry (email, bank details, the signatory mark)
// still come from the User, and any company field left blank falls back to the
// old User value, so an account that has not filled in the master yet renders
// exactly as it did before.
export const documentProfile = (user, company) => {
  const plain = typeof user?.toObject === 'function' ? user.toObject() : { ...(user || {}) };
  if (!company) return plain;

  const addr = company.address || {};
  const primary = company.contacts?.find((c) => c.isPrimary) || company.contacts?.[0] || null;

  // The address line the header prints: street parts joined, city kept separate
  // because companyHeader renders them as "<address>, <city>".
  const street = [addr.line1, addr.line2].filter(Boolean).join(', ');
  const cityLine = [addr.city, addr.state, addr.pincode].filter(Boolean).join(' ');

  return {
    ...plain,
    company: company.name || plain.company,
    // Invoices carry the registered entity where one is recorded; everything
    // else keeps using the trading name above.
    legalName: company.legalName || '',
    address: street || plain.address,
    city: cityLine || plain.city,
    gstNumber: company.gstin || plain.gstNumber,
    panNumber: company.pan || plain.panNumber,
    mobile: primary?.phone || plain.mobile,
    email: primary?.email || plain.email,
    logo: company.logo?.dataUrl || '',
    timezone: company.timezone || 'Asia/Kolkata'
  };
};

// Loads the caller's company master and returns the merged profile for
// document rendering. A missing or archived master is not an error — the
// documents fall back to the User profile, so paperwork never blocks on
// master data being incomplete.
export const profileForDocuments = async (user) => {
  try {
    const company = await Company.findOne({ owner: user._id, status: 'active' });
    return documentProfile(user, company);
  } catch (error) {
    console.error('[company] profile lookup failed:', error.message);
    return documentProfile(user, null);
  }
};
