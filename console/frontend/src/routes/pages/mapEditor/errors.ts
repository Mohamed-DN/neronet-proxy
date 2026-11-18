import type { TFunction } from 'i18next';

import { ApiError } from '../../../services/apiClient';

/**
 * The code of a refusal. The lines API answers `{ error: code, message: sentence }`, which the
 * client turns into an ApiError whose message is the code; a body with `code` sets `code`.
 */
export function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code) return error.code;
  return /^[a-z][a-z_]*$/.test(error.message) ? error.message : null;
}

/** A refusal in words a person can act on. A taken name gets its own sentence. */
export function errorText(t: TFunction<'mapEditor'>, error: unknown): string {
  const code = errorCode(error);
  if (code === 'name_in_use') return t('lineMenu.nameInUse');
  if (code === 'name_required') return t('lineMenu.nameRequired');
  if (error instanceof ApiError) {
    const sentence = (error.details as { message?: unknown } | null)?.message;
    if (typeof sentence === 'string' && sentence) return sentence;
  }
  return error instanceof Error ? error.message : String(error);
}

export const isNameInUse = (error: unknown): boolean => errorCode(error) === 'name_in_use';
