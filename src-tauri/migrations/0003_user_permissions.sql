-- Per-user permission overrides. Each role has default permissions (see role_default in src/lib.rs);
-- a row here grants (1) or denies (0) one permission to one user regardless of the role.
-- No row = the role's default. Admins always have every permission.
CREATE TABLE user_permissions (
  user_id    TEXT NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL CHECK (permission IN ('give_discount', 'dispense_rx', 'view_reports', 'modify_inventory')),
  granted    INTEGER NOT NULL CHECK (granted IN (0, 1)),
  PRIMARY KEY (user_id, permission)
);
