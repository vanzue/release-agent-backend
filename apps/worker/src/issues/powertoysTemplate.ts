function extractTemplateField(body: string, heading: string): string | null {
  // Matches headings like: "### Microsoft PowerToys version"
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^###\\s+${escaped}\\s*$`, 'im');
  const match = re.exec(body);
  if (!match) return null;

  const after = body.slice(match.index + match[0].length);
  const lines = after.split(/\r?\n/);

  // Skip empty lines
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;

  // Collect until next heading
  const collected: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (/^###\s+/.test(line)) break;
    collected.push(line);
    i++;
  }

  const text = collected.join('\n').trim();
  if (!text || text === '_No response_') return null;
  return text;
}

function stripLeadingZeros(input: string): string {
  const stripped = input.replace(/^0+/, '');
  return stripped.length > 0 ? stripped : '0';
}

// Normalize user-entered PowerToys versions into canonical form:
// - Accept canonical 0.x or 0.x.y
// - Accept shorthand x.y (treated as 0.x.y) when x is in a plausible PowerToys range
// - Reject obvious non-PowerToys values (e.g. Windows build numbers)
export function normalizePowertoysVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;

  const aRaw = match[1];
  const bRaw = match[2];
  const cRaw = match[3] ?? null;

  const a = Number.parseInt(aRaw, 10);
  const b = Number.parseInt(bRaw, 10);
  const c = cRaw === null ? null : Number.parseInt(cRaw, 10);

  if (!Number.isFinite(a) || !Number.isFinite(b) || (c !== null && !Number.isFinite(c))) return null;

  // Canonical PowerToys format: 0.x(.y)
  if (a === 0) {
    if (b > 299 || (c !== null && c > 99)) return null;
    return c === null ? `0.${b}` : `0.${b}.${c}`;
  }

  // Shorthand entries like "90.1" => "0.90.1"
  // Keep this conservative to avoid converting unrelated versions/builds.
  if (c === null && a >= 20 && a <= 299 && b <= 99) {
    return `0.${stripLeadingZeros(aRaw)}.${stripLeadingZeros(bRaw)}`;
  }

  // Variants like "095.1.0" => "0.95.1"
  if (c !== null && a >= 20 && a <= 299 && b <= 99 && c <= 99) {
    return `0.${stripLeadingZeros(aRaw)}.${stripLeadingZeros(bRaw)}`;
  }

  return null;
}

export function extractPowertoysReportedVersion(body: string | null): string | null {
  if (!body) return null;
  const v = extractTemplateField(body, 'Microsoft PowerToys version');
  if (!v) return null;
  return normalizePowertoysVersion(v);
}

function toPascalLike(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean)
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : ''))
    .join('');
}

export function normalizeAreaToProductLabel(area: string): string | null {
  const normalized = toPascalLike(area);
  if (!normalized) return null;
  return `Product-${normalized}`;
}

export function extractPowertoysAreaProductLabels(body: string | null): string[] {
  if (!body) return [];
  const area = extractTemplateField(body, 'Area(s) with issue?');
  if (!area) return [];

  // PowerToys templates often use human-readable names like "Light Switch".
  // Convert to a stable label-ish form like "Product-LightSwitch".
  // Only consider the first few lines (before empty line or long text) as areas
  const lines = area.split(/\r?\n/);
  const areaLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at empty line or very long line (likely issue description, not area)
    if (!trimmed || trimmed.length > 80) break;
    areaLines.push(trimmed);
  }

  const parts = areaLines
    .flatMap((line) => line.split(/[,;/]+/g))
    .map((p) => p.trim())
    .filter(Boolean);

  const labels = parts
    .map((p) => normalizeAreaToProductLabel(p))
    .filter((x): x is string => Boolean(x));

  return labels;
}
