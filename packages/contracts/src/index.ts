export type NormalizeBy = 'pr' | 'commit';
export type OutputLanguage = 'english' | 'chinese' | 'bilingual';

export type SessionOptions = {
  normalizeBy?: NormalizeBy;
  outputLanguage?: OutputLanguage;
  strictMode?: boolean;
};

export type ChangeType = 'New' | 'Fix' | 'Change';
export type Risk = 'High' | 'Medium' | 'Low';

export type ChangesArtifact = {
  sessionId: string;
  items: Array<{
    id: string;
    title: string;
    number: number;
    author: string;
    filesChanged: number;
    additions: number;
    deletions: number;
    area: string;
    type: ChangeType;
    risk: Risk;
    signals: string[];
    files: Array<{ path: string; additions: number; deletions: number }>;
  }>;
};

export type ReleaseNoteSource = { kind: 'pr' | 'commit' | 'manual'; ref: string };

export type ReleaseNoteStatus = 'ready' | 'regenerating';

export type ReleaseNoteItem = {
  id: string;
  text: string;
  source: ReleaseNoteSource;
  excluded: boolean;
  status?: ReleaseNoteStatus;
};

export type ReleaseNotesArtifact = {
  sessionId: string;
  sections: Array<{ area: string; items: ReleaseNoteItem[] }>;
};

export type PatchReleaseNotesOp =
  | { op: 'updateText'; itemId: string; text: string }
  | { op: 'exclude'; itemId: string }
  | { op: 'include'; itemId: string }
  | { op: 'addItem'; itemId?: string; area: string; text: string };

export type PatchReleaseNotesRequest = {
  operations: PatchReleaseNotesOp[];
};

export type HotspotsArtifact = {
  sessionId: string;
  items: Array<{
    id: string;
    rank: number;
    area: string;
    score: number;
    drivers: string[];
    contributingPrs: number[];
  }>;
};

export type TestPlanPriority = 'Must' | 'Recommended' | 'Exploratory';

export type TestPlanArtifact = {
  sessionId: string;
  sections: Array<{
    area: string;
    cases: Array<{
      id: string;
      text: string;
      checked: boolean;
      priority: TestPlanPriority;
      source: string;
    }>;
  }>;
};

export type PatchTestPlanOp =
  | { op: 'updateText'; caseId: string; text: string }
  | { op: 'check'; caseId: string }
  | { op: 'uncheck'; caseId: string }
  | { op: 'changePriority'; caseId: string; priority: TestPlanPriority }
  | { op: 'addCase'; caseId?: string; area: string; text: string; priority?: TestPlanPriority }
  | { op: 'deleteCase'; caseId: string };

export type PatchTestPlanRequest = {
  operations: PatchTestPlanOp[];
};

// Regenerate request for release note items
export type RegenerateReleaseNoteRequest = {
  sessionId: string;
  itemId: string;
  commitSha: string;
  repoFullName: string;
};
