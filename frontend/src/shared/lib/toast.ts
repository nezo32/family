import { toast as sonner } from 'sonner';
import { errorMessageRu } from '../api/errors-ru';

/**
 * Toast helpers with the Russian error mapping already applied.
 *
 * Feature code should call `notify.error(err)` and never `toast.error(err.message)`
 * — the server's `message` is English (D7).
 */
export const notify = {
  success: (message: string, description?: string) =>
    sonner.success(message, description ? { description } : undefined),

  info: (message: string, description?: string) =>
    sonner.info(message, description ? { description } : undefined),

  warning: (message: string, description?: string) =>
    sonner.warning(message, description ? { description } : undefined),

  /**
   * `error` may be an `ApiError`, a `NetworkError` or anything else — it is
   * translated to Russian by `errorMessageRu`. Pass a `title` to keep the
   * translated text as the description instead.
   */
  error: (error: unknown, title?: string) => {
    const message = errorMessageRu(error);
    return title ? sonner.error(title, { description: message }) : sonner.error(message);
  },

  loading: (message: string) => sonner.loading(message),

  dismiss: (id?: string | number) => {
    sonner.dismiss(id);
  },

  /** Escape hatch for the rare bespoke toast. */
  raw: sonner,
};
