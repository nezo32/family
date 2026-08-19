/**
 * Public surface of the notification inbox.
 *
 * The shell imports the panel and the badge hook from here; nothing outside the
 * feature should reach into `api.ts` directly.
 */
export {
  fetchInbox,
  fetchReceipts,
  fetchUnreadCount,
  isUnread,
  markRead,
  needsAck,
  notificationKeys,
  type InboxPage,
  type NotificationReceipts,
} from './api';
export {
  inboxItems,
  pendingAcknowledgements,
  useAcknowledge,
  useDeliveryReceipts,
  useInbox,
  useMarkRead,
  usePushHealth,
  useUnreadCount,
  type PushHealth,
} from './hooks';
export { NotificationsPanel } from './components/NotificationsPanel';
export { NotificationItem } from './components/NotificationItem';
export { PushHealthBanner } from './components/PushHealthBanner';
export { DeliveryReceipts } from './components/DeliveryReceipts';
export { NOTIFICATIONS_RU } from './locale';
