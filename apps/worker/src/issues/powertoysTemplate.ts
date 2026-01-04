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

export function extractPowertoysReportedVersion(body: string | null): string | null {
  if (!body) return null;
  const v = extractTemplateField(body, 'Microsoft PowerToys version');
  if (!v) return null;
  const m = v.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m?.[1] ?? null;
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
