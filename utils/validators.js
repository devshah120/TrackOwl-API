export const validateEmail = (email) => {
  const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
  return emailRegex.test(email);
};

export const validatePassword = (password) => {
  return password && password.length >= 8;
};

export const validateMobile = (mobile) => {
  const mobileRegex = /^\d{10}$/;
  const cleanMobile = mobile.replace(/\D/g, '');
  return mobileRegex.test(cleanMobile);
};

export const validateCompany = (company) => {
  return company && company.trim().length >= 2;
};

export const validateFleet = (fleet) => {
  const validFleets = ['1–5 trucks', '6–20 trucks', '21–50 trucks', '50+ trucks'];
  return validFleets.includes(fleet);
};
