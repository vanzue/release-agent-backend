/**
 * Deep clone a JSON-serializable value.
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Find or create a section in an array by area name.
 */
export function ensureSection<T extends { area: string }>(
  sections: T[],
  area: string,
  create: () => T
): T {
  const existing = sections.find((s) => s.area === area);
  if (existing) return existing;
  const created = create();
  sections.push(created);
  return created;
}
