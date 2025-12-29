import type { PullRequest, PullRequestFile } from './github.js';
import type { ChangeType, Risk, ChangesArtifact } from '@release-agent/contracts';

/**
 * PowerToys area tags for categorizing changes
 */
const POWERTOYS_AREAS = [
  'Settings',
  'AlwaysOnTop',
  'Awake',
  'ColorPicker',
  'CmdNotFound',
  'LightSwitch',
  'FancyZones',
  'FileLocksmith',
  'Run',
  'ImageResizer',
  'KeyboardManager',
  'CursorWrap',
  'FindMyMouse',
  'MouseHighlighter',
  'MouseCrosshair',
  'MouseJump',
  'MouseWithoutBorders',
  'Peek',
  'PowerAccent',
  'PowerLauncher',
  'PowerPreview',
  'PowerRename',
  'FileExplorer',
  'ShortcutGuide',
  'Hosts',
  'MeasureTool',
  'PowerOCR',
  'Workspaces',
  'RegistryPreview',
  'CropAndLock',
  'EnvironmentVariables',
  'AdvancedPaste',
  'NewPlus',
  'CmdPal',
  'ZoomIt',
  'Runner',
  'Test',
  'Development',
] as const;

/**
 * Map of folder/path patterns to PowerToys areas
 */
const PATH_TO_AREA: Record<string, string> = {
  // Settings
  'settings': 'Settings',
  'settings-ui': 'Settings',
  'settingsui': 'Settings',
  // AlwaysOnTop
  'alwaysontop': 'AlwaysOnTop',
  'always-on-top': 'AlwaysOnTop',
  // Awake
  'awake': 'Awake',
  // ColorPicker
  'colorpicker': 'ColorPicker',
  'color-picker': 'ColorPicker',
  // CmdNotFound
  'cmdnotfound': 'CmdNotFound',
  'cmd-not-found': 'CmdNotFound',
  'commandnotfound': 'CmdNotFound',
  // LightSwitch (new name for theme toggle)
  'lightswitch': 'LightSwitch',
  // FancyZones
  'fancyzones': 'FancyZones',
  'fancy-zones': 'FancyZones',
  // FileLocksmith
  'filelocksmith': 'FileLocksmith',
  'file-locksmith': 'FileLocksmith',
  // Run (PowerToys Run)
  'launcher': 'Run',
  'powertoys-run': 'Run',
  'powertoysrun': 'Run',
  // ImageResizer
  'imageresizer': 'ImageResizer',
  'image-resizer': 'ImageResizer',
  // KeyboardManager
  'keyboardmanager': 'KeyboardManager',
  'keyboard-manager': 'KeyboardManager',
  // CursorWrap (new mouse utility)
  'cursorwrap': 'CursorWrap',
  // FindMyMouse
  'findmymouse': 'FindMyMouse',
  'find-my-mouse': 'FindMyMouse',
  // MouseHighlighter
  'mousehighlighter': 'MouseHighlighter',
  'mouse-highlighter': 'MouseHighlighter',
  // MouseCrosshair (was MousePointerCrosshairs)
  'mousecrosshair': 'MouseCrosshair',
  'mouse-crosshair': 'MouseCrosshair',
  'mousepointercrosshairs': 'MouseCrosshair',
  // MouseJump
  'mousejump': 'MouseJump',
  'mouse-jump': 'MouseJump',
  // MouseWithoutBorders
  'mousewithoutborders': 'MouseWithoutBorders',
  'mouse-without-borders': 'MouseWithoutBorders',
  // Peek
  'peek': 'Peek',
  // PowerAccent
  'poweraccent': 'PowerAccent',
  'power-accent': 'PowerAccent',
  'quickaccent': 'PowerAccent',
  // PowerLauncher (same as Run but different folder name)
  'powerlauncher': 'PowerLauncher',
  // PowerPreview (File Explorer add-ons)
  'powerpreview': 'PowerPreview',
  'power-preview': 'PowerPreview',
  'previewhandler': 'PowerPreview',
  // PowerRename
  'powerrename': 'PowerRename',
  'power-rename': 'PowerRename',
  // FileExplorer
  'fileexplorer': 'FileExplorer',
  'file-explorer': 'FileExplorer',
  'fileexploreraddons': 'FileExplorer',
  // ShortcutGuide
  'shortcutguide': 'ShortcutGuide',
  'shortcut-guide': 'ShortcutGuide',
  // Hosts
  'hosts': 'Hosts',
  'hostsfileeditor': 'Hosts',
  // MeasureTool (Screen Ruler)
  'measuretool': 'MeasureTool',
  'measure-tool': 'MeasureTool',
  'screenruler': 'MeasureTool',
  // PowerOCR (Text Extractor)
  'powerocr': 'PowerOCR',
  'power-ocr': 'PowerOCR',
  'textextractor': 'PowerOCR',
  // Workspaces
  'workspaces': 'Workspaces',
  // RegistryPreview
  'registrypreview': 'RegistryPreview',
  'registry-preview': 'RegistryPreview',
  // CropAndLock
  'cropandlock': 'CropAndLock',
  'crop-and-lock': 'CropAndLock',
  // EnvironmentVariables
  'environmentvariables': 'EnvironmentVariables',
  'environment-variables': 'EnvironmentVariables',
  // AdvancedPaste
  'advancedpaste': 'AdvancedPaste',
  'advanced-paste': 'AdvancedPaste',
  // NewPlus (New+)
  'newplus': 'NewPlus',
  'new-plus': 'NewPlus',
  'new+': 'NewPlus',
  // CmdPal (Command Palette)
  'cmdpal': 'CmdPal',
  'commandpalette': 'CmdPal',
  // ZoomIt
  'zoomit': 'ZoomIt',
  // Runner
  'runner': 'Runner',
  // Test
  'test': 'Test',
  'tests': 'Test',
  'unittest': 'Test',
  // Development
  'dev': 'Development',
  'common': 'Development',
  'interop': 'Development',
};

function labelNames(pr: PullRequest) {
  return (pr.labels ?? [])
    .map((l) => l?.name)
    .filter((x): x is string => Boolean(x));
}

function inferType(labels: string[], title: string): ChangeType {
  const joined = labels.map((l) => l.toLowerCase());
  if (joined.some((l) => l.includes('bug') || l.includes('fix') || l.includes('crash') || l.includes('regression'))) {
    return 'Fix';
  }
  if (/^fix(\(.+\))?:/i.test(title) || /^bugfix/i.test(title)) return 'Fix';
  if (joined.some((l) => l.includes('feature') || l.includes('enhancement'))) return 'New';
  if (/^feat(\(.+\))?:/i.test(title)) return 'New';
  return 'Change';
}

function inferRisk(filesChanged: number, additions: number, deletions: number): Risk {
  const churn = additions + deletions;
  if (filesChanged >= 20 || churn >= 2000) return 'High';
  if (filesChanged >= 8 || churn >= 600) return 'Medium';
  return 'Low';
}

function inferArea(labels: string[], files: PullRequestFile[]): string {
  // First, try to match PowerToys areas from labels
  const labelAreas = new Set(POWERTOYS_AREAS.map((a) => a.toLowerCase()));
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    // Direct match with PowerToys area
    if (labelAreas.has(normalized)) {
      // Return the properly cased version
      const match = POWERTOYS_AREAS.find((a) => a.toLowerCase() === normalized);
      if (match) return match;
    }
    // Check if label contains "Product-" prefix (common in PowerToys)
    if (normalized.startsWith('product-')) {
      const areaName = normalized.slice(8); // Remove "Product-" prefix
      const match = POWERTOYS_AREAS.find((a) => a.toLowerCase() === areaName);
      if (match) return match;
    }
    // Check if label contains "Area-" prefix
    if (normalized.startsWith('area-')) {
      const areaName = normalized.slice(5); // Remove "Area-" prefix
      const match = POWERTOYS_AREAS.find((a) => a.toLowerCase() === areaName);
      if (match) return match;
    }
  }

  // Second, infer from file paths
  for (const file of files) {
    const pathParts = file.filename.toLowerCase().split('/');
    for (const part of pathParts) {
      const cleanPart = part.replace(/[^a-z0-9]/g, '');
      if (PATH_TO_AREA[cleanPart]) {
        return PATH_TO_AREA[cleanPart];
      }
      // Also check the original part (with hyphens etc)
      if (PATH_TO_AREA[part]) {
        return PATH_TO_AREA[part];
      }
    }
  }

  // Fallback: Development (default for unrecognized areas)
  return 'Development';
}

function inferSignals(files: PullRequestFile[], labels: string[], title: string): string[] {
  const signals = new Set<string>();
  const lowTitle = title.toLowerCase();
  const lowLabels = labels.map((l) => l.toLowerCase());
  const paths = files.map((f) => f.filename.toLowerCase());

  const addIf = (cond: boolean, s: string) => {
    if (cond) signals.add(s);
  };

  addIf(lowTitle.includes('installer') || lowLabels.some((l) => l.includes('installer')), 'Installer');
  addIf(paths.some((p) => p.includes('setup') || p.includes('installer')), 'Installer');
  addIf(paths.some((p) => p.endsWith('.csproj') || p.endsWith('.sln') || p.includes('packages.lock.json')), 'Build system');
  addIf(paths.some((p) => p.includes('telemetry') || p.includes('analytics')), 'Telemetry');
  addIf(paths.some((p) => p.includes('settings') || p.includes('config')), 'Settings');
  addIf(paths.some((p) => p.includes('ui') || p.endsWith('.xaml') || p.endsWith('.tsx') || p.endsWith('.css')), 'UI');
  addIf(paths.some((p) => p.includes('hotkey') || p.includes('keyboard') || p.includes('input')), 'Input');

  return [...signals];
}

export function buildChangesArtifact(sessionId: string, prs: Array<{ pr: PullRequest; files: PullRequestFile[] }>): ChangesArtifact {
  const items = prs.map(({ pr, files }) => {
    const labels = labelNames(pr);
    const author = pr.user?.login ?? 'unknown';
    const type = inferType(labels, pr.title);
    const risk = inferRisk(pr.changed_files ?? files.length, pr.additions ?? 0, pr.deletions ?? 0);
    const area = inferArea(labels, files);
    const signals = inferSignals(files, labels, pr.title);

    return {
      id: `pr-${pr.number}`,
      title: pr.title,
      number: pr.number,
      author,
      filesChanged: pr.changed_files ?? files.length,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      area,
      type,
      risk,
      signals,
      files: files.map((f) => ({ path: f.filename, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    };
  });

  return { sessionId, items };
}

