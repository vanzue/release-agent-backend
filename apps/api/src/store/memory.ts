import { randomUUID } from 'node:crypto';

// type ReleaseStatus = 'active' | 'archived';
type SessionStatus = 'draft' | 'generating' | 'ready' | 'exported';
type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
type JobType = 'parse-changes' | 'generate-notes' | 'analyze-hotspots' | 'generate-testplan';

export type Session = {
  id: string;
  repoFullName: string;
  name: string;
  status: SessionStatus;
  baseRef: string;
  headRef: string;
  options: {
    normalizeBy?: 'pr' | 'commit';
    outputLanguage?: 'english' | 'chinese' | 'bilingual';
    strictMode?: boolean;
  };
  stats: {
    changeCount: number;
    releaseNotesCount: number;
    hotspotsCount: number;
    testCasesCount: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type Job = {
  id: string;
  sessionId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

const now = () => new Date().toISOString();

const sessions = new Map<string, Session>();
const jobs = new Map<string, Job[]>();

export const MemoryStore = {
  listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  createSession(input: Pick<Session, 'repoFullName' | 'name' | 'baseRef' | 'headRef' | 'options'>): Session {
    const id = randomUUID();
    const createdAt = now();
    const session: Session = {
      id,
      repoFullName: input.repoFullName,
      name: input.name,
      status: 'generating',
      baseRef: input.baseRef,
      headRef: input.headRef,
      options: input.options,
      stats: { changeCount: 0, releaseNotesCount: 0, hotspotsCount: 0, testCasesCount: 0 },
      createdAt,
      updatedAt: createdAt,
    };
    sessions.set(id, session);

    const initialJobs: Job[] = [
      { id: randomUUID(), sessionId: id, type: 'parse-changes', status: 'pending', progress: 0 },
      { id: randomUUID(), sessionId: id, type: 'generate-notes', status: 'pending', progress: 0 },
      { id: randomUUID(), sessionId: id, type: 'analyze-hotspots', status: 'pending', progress: 0 },
      { id: randomUUID(), sessionId: id, type: 'generate-testplan', status: 'pending', progress: 0 },
    ];
    jobs.set(id, initialJobs);

    return session;
  },

  getSession(sessionId: string): Session | null {
    return sessions.get(sessionId) ?? null;
  },

  listJobs(sessionId: string): Job[] {
    return jobs.get(sessionId) ?? [];
  },
};

