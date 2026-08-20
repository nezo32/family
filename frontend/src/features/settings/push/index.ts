/**
 * Client-side Web Push.
 *
 * `payload.ts`, `ack-queue.ts` and `messages.ts` are also imported by
 * `src/sw.ts` through relative paths and must stay free of DOM/React code — do
 * not re-export them from a barrel that pulls in components, or the service
 * worker bundle grows a React dependency.
 */
export {
  PUSH_STARTUP_GRACE_MS,
  currentEndpoint,
  deviceLabel,
  disablePush,
  enablePush,
  flushAckQueue,
  installReconcileLoop,
  isIos,
  isIosNonSafari,
  isPushReady,
  isPushSupported,
  isStandalone,
  clearEnableOutcome,
  clearPushFailure,
  lastEnableOutcome,
  lastPushFailure,
  noteServiceWorkerRegistration,
  onPushReadinessChange,
  recordPushFailure,
  recordRegistrationError,
  permissionState,
  postSubscription,
  primeRegistration,
  pushAvailability,
  pushReadiness,
  pushRegistration,
  reconcileSubscription,
  registrationSnapshot,
  setPrimedRegistration,
  urlBase64ToUint8Array,
  vapidPublicKey,
  type EnableOutcome,
  type EnableResult,
  type PushAvailability,
  type PushFailure,
  type PushPermission,
  type PushReadiness,
  type ReconcileOutcome,
  type RegistrationSnapshot,
} from './push';
export { usePush, type PushState, type UsePushResult } from './use-push';
export {
  PUSH_DIAGNOSTICS_ANCHOR,
  PushDeniedCard,
  PushFailureCard,
  PushInstallCard,
  PushPrompt,
  PushReEnableCard,
  PushSection,
  PushWorkerCard,
} from './PushPrompt';
export { isEnableFailure, reportEnableOutcome, type FailureOutcome } from './enable-report';
/**
 * The on-device instrument. Exported from the barrel because it is the thing
 * we ask the owner to open when push does not work, and it must be findable.
 */
export { PushDiagnosticsCard } from './PushDiagnosticsCard';
export {
  collectPushDiagnostics,
  fingerprintEndpoint,
  formatPushDiagnostics,
  pushVerdict,
  type PushDiagnostics,
  type PushVerdict,
} from './diagnostics';
export { useServiceWorkerBridge } from './sw-bridge';
