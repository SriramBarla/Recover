// Joins class names, skipping empty values. The design system's only helper; no dependency.
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  let out = '';
  for (const p of parts) {
    if (p) out = out ? `${out} ${p}` : p;
  }
  return out;
}

// Merges aria-describedby id lists, dropping empties and duplicates.
export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const seen: string[] = [];
  for (const group of ids) {
    if (!group) continue;
    for (const id of group.split(/\s+/)) {
      if (id && !seen.includes(id)) seen.push(id);
    }
  }
  return seen.length > 0 ? seen.join(' ') : undefined;
}
