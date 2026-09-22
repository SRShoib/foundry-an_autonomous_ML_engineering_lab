/** Joins class names, dropping the falsy ones. Deliberately not tailwind-merge: components here
 * compose from a small token vocabulary and never rely on a later class overriding an earlier one. */
export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
