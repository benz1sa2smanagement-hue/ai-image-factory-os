import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncRemoteTask, getGitContext } from '../src/git-utils.ts';
import type { GitContext } from '../src/git-utils.ts';

describe('git-utils & remote task synchronization', () => {
  const tempDir = path.resolve(process.cwd(), 'scratch-git-sync-test');
  const tempTaskFile = path.resolve(tempDir, 'AI_TASK.md');

  const sampleLocalDoc = `
# AI TASK — ChatGPT → Claude Code

## Current Task

**TASK ID:** TASK-002
**STATUS:** LOCAL READY
**TITLE:** Local task title
**SOURCE:** GitHub Issue #6

### Objective
Do local work.

### Required work
1. Work item 1

### Hard constraints
- MAX_ALLOWED_COST = 0
`;

  const sampleRemoteDoc = `
# AI TASK — ChatGPT → Claude Code

## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** Authoritative remote task title from GitHub
**SOURCE:** GitHub Issue #6

### Objective
Do remote authoritative work.

### Required work
1. Remote work item 1

### Hard constraints
- MAX_ALLOWED_COST = 0
`;

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(tempTaskFile, sampleLocalDoc, 'utf-8');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('detects clean working tree and fast-forwards remote task', async () => {
    let mergeCalled = false;

    const mockGit: GitContext = {
      remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
      branch: 'main',
      commitSha: 'commit-local',
      isClean: true,
      uncommittedFiles: [],
    };

    const result = await syncRemoteTask({
      cwd: tempDir,
      taskFilePath: tempTaskFile,
      gitContextResolver: async () => mockGit,
      fetcher: async () => ({ ok: true }),
      remoteContentGetter: async () => ({ ok: true, content: sampleRemoteDoc }),
      fastForwardMerger: async () => {
        mergeCalled = true;
        // Simulate fast-forward updating the local task file
        await fs.writeFile(tempTaskFile, sampleRemoteDoc, 'utf-8');
        return { ok: true };
      },
    });

    expect(result.synced).toBe(true);
    expect(result.state).toBe('REMOTE_FETCHED');
    expect(mergeCalled).toBe(true);
    expect(result.localTask?.title).toBe('Authoritative remote task title from GitHub');
    expect(result.remoteTask?.status).toBe('READY');
  });

  it('detects dirty working tree and stops safely with SYNC_CONFLICT without overwriting', async () => {
    let mergeCalled = false;

    // Working tree has an uncommitted file: e.g. packages/domain/src/work.ts
    const mockGit: GitContext = {
      remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
      branch: 'main',
      commitSha: 'commit-local',
      isClean: false,
      uncommittedFiles: ['packages/domain/src/work.ts'],
    };

    const result = await syncRemoteTask({
      cwd: tempDir,
      taskFilePath: tempTaskFile,
      gitContextResolver: async () => mockGit,
      fetcher: async () => ({ ok: true }),
      remoteContentGetter: async () => ({ ok: true, content: sampleRemoteDoc }),
      fastForwardMerger: async () => {
        mergeCalled = true;
        return { ok: true };
      },
    });

    expect(result.synced).toBe(false);
    expect(result.state).toBe('CONFLICT');
    expect(result.code).toBe('SYNC_CONFLICT');
    expect(result.reason).toContain('uncommitted changes');
    expect(result.reason).toContain('packages/domain/src/work.ts');
    expect(mergeCalled).toBe(false); // MUST NOT merge or overwrite

    // Verify local task file remains completely unchanged
    const localContentAfter = await fs.readFile(tempTaskFile, 'utf-8');
    expect(localContentAfter).toBe(sampleLocalDoc);
    expect(localContentAfter).toContain('Local task title');
  });

  it('handles matching clean repository without unnecessary merge (UP_TO_DATE)', async () => {
    let mergeCalled = false;

    const mockGit: GitContext = {
      remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
      branch: 'main',
      commitSha: 'commit-same',
      isClean: true,
      uncommittedFiles: [],
    };

    const result = await syncRemoteTask({
      cwd: tempDir,
      taskFilePath: tempTaskFile,
      gitContextResolver: async () => mockGit,
      fetcher: async () => ({ ok: true }),
      remoteContentGetter: async () => ({ ok: true, content: sampleLocalDoc }),
      fastForwardMerger: async () => {
        mergeCalled = true;
        return { ok: true };
      },
    });

    expect(result.synced).toBe(true);
    expect(result.state).toBe('UP_TO_DATE');
    expect(mergeCalled).toBe(false);
  });

  it('falls back safely to local state when remote fetch fails (offline)', async () => {
    const mockGit: GitContext = {
      remoteUrl: 'git@github.com:benz1sa2smanagement-hue/ai-image-factory-os.git',
      branch: 'main',
      commitSha: 'commit-local',
      isClean: true,
      uncommittedFiles: [],
    };

    const result = await syncRemoteTask({
      cwd: tempDir,
      taskFilePath: tempTaskFile,
      gitContextResolver: async () => mockGit,
      fetcher: async () => ({ ok: false, error: 'Could not resolve host: github.com' }),
    });

    expect(result.synced).toBe(false);
    expect(result.state).toBe('OFFLINE');
    expect(result.localTask?.status).toBe('LOCAL READY');
  });
});
