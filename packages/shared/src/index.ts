/**
 * `@family/shared` — the contract between the API and the PWA.
 *
 * Everything here is imported by BOTH `backend` and `frontend`, so it must stay
 * free of Node-only and browser-only APIs: zod schemas, plain types, and pure
 * functions only.
 *
 * Note on the RBAC matrix: `ROLE_PERMISSIONS` lives here for a single source of
 * truth and unit testing, but the **frontend must never read it**. The client
 * receives its effective permission list from `GET /api/me`; deriving it
 * client-side would make a stale bundle render buttons that 403 (D4).
 */

// Domain primitives
export * from './domain/roles.js';
export * from './domain/errors.js';
export * from './domain/routes.js';
export * from './domain/percent.js';
export * from './domain/plural.js';
export * from './domain/quick-add.js';

// Contracts
export * from './contracts/common.js';
export * from './contracts/auth.js';
export * from './contracts/users.js';
export * from './contracts/tasks.js';
export * from './contracts/events.js';
export * from './contracts/chores.js';
export * from './contracts/goals.js';
export * from './contracts/shopping.js';
export * from './contracts/wall.js';
export * from './contracts/notifications.js';
export * from './contracts/dashboard.js';
export * from './contracts/changes.js';
