// Fill-in grading, ported verbatim from the quiz room the bank was authored for:
// character-level normalization, not semantic understanding. Text compares the
// normalized input against the answer and every accepted alternative; number and
// sequence kinds have dedicated shapes that deliberately ignore `accepted`.
export type FillField = { label: string; kind: string; answer: string; accepted?: string[]; displayAnswer?: string };

export function normalizeAnswer(value: string) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/\s/g, '')
    .replace(/[;；。]+$/g, '');
}

const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/;

export function matchesField(value: string, field: FillField) {
  if (!String(value).trim()) return false;
  const normalized = normalizeAnswer(value);
  if (field.kind === 'number') {
    return numberPattern.test(normalized) && Number.isFinite(Number(normalized)) && Number(normalized) === Number(field.answer);
  }
  if (field.kind === 'sequence') {
    const input = String(value).normalize('NFKC').replace(/[[\](){}]/g, '').trim();
    if (!/^[\d\s,，、;；+-]+$/.test(input)) return false;
    const tokens = input.split(/[\s,，、;；]+/).filter(Boolean);
    if (!tokens.every(token => /^[+-]?\d+$/.test(token))) return false;
    const expected = String(field.answer).match(/-?\d+/g)?.map(Number) ?? [];
    return tokens.length === expected.length && tokens.every((token, index) => Number(token) === expected[index]);
  }
  return normalizeAnswer(field.answer) === normalized || (field.accepted ?? []).some(answer => normalizeAnswer(answer) === normalized);
}

// One boolean per blank; the question is correct only when every blank is.
export function gradeFill(fields: readonly FillField[], values: readonly (string | undefined)[]) {
  return fields.map((field, index) => matchesField(values[index] ?? '', field));
}
