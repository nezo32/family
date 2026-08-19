/**
 * Schema barrel.
 *
 * Every module owns its own `*.schema.ts`; this file re-exports all of them so
 * that `drizzle-kit` sees one schema and the Drizzle client gets a fully typed
 * relational map.
 *
 * Owned by the lead — module agents must not edit it. Add a line here when a
 * new module schema lands, nothing else.
 */

// Identity & access
export * from '../modules/identity/users.schema.js';
export * from '../modules/identity/identity.schema.js';

// Scheduling primitives shared by tasks and events
export * from '../modules/scheduling/recurrence.schema.js';

// Tasks, events, chores
export * from '../modules/tasks/tasks.schema.js';
export * from '../modules/events/events.schema.js';
export * from '../modules/chores/chores.schema.js';

// Household domains
export * from '../modules/goals/goals.schema.js';
export * from '../modules/shopping/shopping.schema.js';
export * from '../modules/wall/wall.schema.js';

// Notifications
export * from '../modules/notifications/notifications.schema.js';
