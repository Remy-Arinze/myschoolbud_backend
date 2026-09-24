const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+\d{10,15})|(?:\b0\d{10}\b)/;
const TOKEN = /\b[A-Za-z0-9_-]{32,}\b/;

/** True when the text carries an email, a phone number, or a long token. */
export function noticeTextHasSecret(value: string): boolean {
  if (!value) return false;
  if (EMAIL.test(value)) return true;
  const compact = value.replace(/[\s().-]/g, '');
  if (PHONE.test(compact)) return true;
  if (TOKEN.test(value)) return true;
  return false;
}

export function plainFileLabel(name: string): string {
  const base = (name || '').split(/[/\\]/).pop()?.trim() || '';
  if (!base || /^https?:/i.test(base) || /cloudinary|googleapis|amazonaws/i.test(base)) {
    return 'A file';
  }
  return base.slice(0, 80);
}

export function safeNoticeField(value: string, fallback: string): string {
  const text = (value || '').trim();
  if (!text || noticeTextHasSecret(text)) return fallback;
  return text;
}
