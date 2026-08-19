import { ERROR_CODES, type ErrorCode } from '@family/shared';
import { isApiError, isNetworkError } from './errors';
import type { ApiError } from './errors';

/**
 * `ErrorCode` → Russian, user-facing message.
 *
 * D7: never render the server's `message` field — it is English and written for
 * developers. This map is exhaustive by construction: `Record<ErrorCode, string>`
 * means adding a code to `@family/shared` breaks the build here until it gets a
 * translation.
 */
export const ERROR_MESSAGES_RU: Record<ErrorCode, string> = {
  // 400
  VALIDATION_ERROR: 'Проверьте заполненные поля — что-то введено некорректно.',
  BAD_REQUEST: 'Запрос не удалось обработать. Попробуйте ещё раз.',

  // 401
  UNAUTHENTICATED: 'Нужно войти в приложение.',
  INVALID_CREDENTIALS: 'Не удалось войти: неверные данные.',
  TOKEN_EXPIRED: 'Сессия истекла. Войдите снова.',
  TOKEN_INVALID: 'Сессия недействительна. Войдите снова.',
  REFRESH_TOKEN_REUSED:
    'Сессия завершена в целях безопасности: вход был выполнен с другого устройства. Войдите снова.',

  // 403
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  ACCOUNT_PENDING_APPROVAL: 'Заявка ещё на рассмотрении у администратора семьи.',
  ACCOUNT_REJECTED: 'Заявка на вступление отклонена.',
  ACCOUNT_SUSPENDED: 'Доступ к семье приостановлен.',
  LAST_LOGIN_METHOD: 'Это единственный способ входа — сначала добавьте другой.',
  LAST_OWNER: 'В семье должен остаться хотя бы один владелец.',

  // 404
  NOT_FOUND: 'Не найдено. Возможно, запись удалили.',

  // 409
  CONFLICT: 'Данные изменились. Обновите страницу и попробуйте ещё раз.',
  ALREADY_EXISTS: 'Такая запись уже есть.',
  IDENTITY_ALREADY_LINKED: 'Этот аккаунт уже привязан к другому участнику.',
  STALE_VERSION: 'Кто-то изменил эту запись раньше вас. Обновите и попробуйте снова.',

  // 413 / 415
  PAYLOAD_TOO_LARGE: 'Файл слишком большой.',
  UNSUPPORTED_MEDIA_TYPE: 'Такой тип файла не поддерживается.',

  // 429
  RATE_LIMITED: 'Слишком много попыток. Подождите немного и повторите.',

  // 5xx
  INTERNAL_ERROR: 'Что-то пошло не так на сервере. Мы уже знаем об этом.',
  SERVICE_UNAVAILABLE: 'Сервис временно недоступен. Попробуйте через минуту.',
  OAUTH_PROVIDER_ERROR: 'Провайдер входа не ответил. Попробуйте другой способ.',
};

/** Shown when the request never left the device. */
export const NETWORK_ERROR_MESSAGE_RU = 'Нет соединения. Проверьте интернет и повторите.';

/** Last-resort message for a genuinely unknown throw. */
export const UNKNOWN_ERROR_MESSAGE_RU = 'Непредвиденная ошибка. Попробуйте ещё раз.';

export function errorCodeMessageRu(code: ErrorCode): string {
  return ERROR_MESSAGES_RU[code];
}

/**
 * Turn anything thrown by the API layer into a Russian sentence.
 * Safe to call with `unknown` straight out of a `catch` or a react-query
 * `error` field.
 */
export function errorMessageRu(error: unknown): string {
  if (isApiError(error)) {
    const base = ERROR_MESSAGES_RU[error.code];
    const firstFieldIssue = firstDetailMessage(error);
    return firstFieldIssue ? `${base} ${firstFieldIssue}` : base;
  }
  if (isNetworkError(error)) return NETWORK_ERROR_MESSAGE_RU;
  return UNKNOWN_ERROR_MESSAGE_RU;
}

/** Field errors from a `VALIDATION_ERROR`, ready to feed into RHF `setError`. */
export function fieldErrors(error: unknown): Record<string, string[]> {
  if (isApiError(error) && error.details) return error.details;
  return {};
}

function firstDetailMessage(error: ApiError): string | null {
  if (error.code !== 'VALIDATION_ERROR' || !error.details) return null;
  for (const messages of Object.values(error.details)) {
    const first = messages[0];
    if (first) return first;
  }
  return null;
}

/** Guards against a code being added upstream without a translation. */
export function assertAllCodesTranslated(): void {
  for (const code of ERROR_CODES) {
    if (!ERROR_MESSAGES_RU[code]) {
      throw new Error(`Missing Russian message for error code ${code}`);
    }
  }
}
