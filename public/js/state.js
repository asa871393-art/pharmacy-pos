// App-wide state shared by the shell and the pages.
export const ctx = {
  me: null,        // { id, username, full_name, role, permissions }
  settings: null,  // { pharmacy_name, max_discount_pct, expiry_warn_days }
  shift: null,     // current user's open shift summary, or null
  route: null      // name of the visible page
};

export const can = (perm) => !!ctx.me && ctx.me.permissions.includes(perm);
