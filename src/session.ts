import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, TranscriptEntry, GombweConfig } from './types.js';

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionsDir: string;
  private indexFile: string;

  constructor(config: GombweConfig) {
    this.sessionsDir = join(config.dataDir, 'sessions');
    this.indexFile = join(config.dataDir, 'sessions', '_index.json');
    this.loadIndex();
  }

  /** Load session index (keys + metadata, not full transcripts) */
  private loadIndex(): void {
    if (existsSync(this.indexFile)) {
      const raw = readFileSync(this.indexFile, 'utf-8');
      const entries: Session[] = JSON.parse(raw);
      for (const entry of entries) {
        // Don't load full transcript into memory — lazy load
        entry.transcript = [];
        this.sessions.set(entry.key, entry);
      }
    }
  }

  private persistIndex(): void {
    // Save index without transcripts (those are in separate JSONL files)
    const entries = Array.from(this.sessions.values()).map(s => ({
      ...s,
      transcript: [], // Don't save transcripts in index
    }));
    writeFileSync(this.indexFile, JSON.stringify(entries, null, 2));
  }

  getOrCreate(key: string, channel: string): Session {
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        channel,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        transcript: [],
        mode: 'chat',
      };
      this.sessions.set(key, session);
      this.persistIndex();
    }

    // Lazy-load transcript if empty
    if (session.transcript.length === 0) {
      const transcriptFile = this.transcriptPath(key);
      if (existsSync(transcriptFile)) {
        const lines = readFileSync(transcriptFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { session.transcript.push(JSON.parse(line)); } catch {}
        }
      }
    }

    session.lastActiveAt = new Date().toISOString();
    return session;
  }

  addEntry(key: string, entry: TranscriptEntry): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.transcript.push(entry);
    session.lastActiveAt = new Date().toISOString();

    appendFileSync(this.transcriptPath(key), JSON.stringify(entry) + '\n');
    this.persistIndex();
  }

  /** Store the Claude CLI session ID so we can --resume later */
  setClaudeSessionId(key: string, claudeSessionId: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.claudeSessionId = claudeSessionId;
    this.persistIndex();
  }

  getClaudeSessionId(key: string): string | undefined {
    return this.sessions.get(key)?.claudeSessionId;
  }

  setMode(key: string, mode: 'chat' | 'task'): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.mode = mode;
    this.persistIndex();
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
  }

  getSession(key: string): Session | undefined {
    const session = this.sessions.get(key);
    if (session && session.transcript.length === 0) {
      // Lazy load
      const transcriptFile = this.transcriptPath(key);
      if (existsSync(transcriptFile)) {
        const lines = readFileSync(transcriptFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { session.transcript.push(JSON.parse(line)); } catch {}
        }
      }
    }
    return session;
  }

  deleteSession(key: string): boolean {
    const deleted = this.sessions.delete(key);
    if (deleted) this.persistIndex();
    return deleted;
  }

  private transcriptPath(key: string): string {
    return join(this.sessionsDir, `${key.replace(/[/:]/g, '_')}.jsonl`);
  }
}
