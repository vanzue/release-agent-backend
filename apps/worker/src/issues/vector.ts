export function toVectorLiteral(values: number[]): string {
  // pgvector accepts '[1,2,3]' style literals.
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

export function parseVector(text: unknown): number[] {
  if (Array.isArray(text)) return text.map((n) => Number(n));
  if (typeof text !== 'string') throw new Error(`Invalid vector value type: ${typeof text}`);

  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`Invalid vector format: ${trimmed.slice(0, 32)}`);
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((s) => Number.parseFloat(s.trim()));
}

export function meanVector(current: number[], currentSize: number, next: number[]): number[] {
  if (currentSize <= 0) return next.slice();
  if (current.length !== next.length) {
    throw new Error(`Vector dimension mismatch: ${current.length} vs ${next.length}`);
  }

  const denom = currentSize + 1;
  const out = new Array<number>(current.length);
  for (let i = 0; i < current.length; i++) {
    out[i] = (current[i] * currentSize + next[i]) / denom;
  }
  return out;
}

