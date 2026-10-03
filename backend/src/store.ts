import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type User = { id: string; email: string; appAccountToken: string };
export type Provider = 'mercadopago' | 'apple';
export type SubscriptionStatus = 'pending' | 'active' | 'paused' | 'cancelled' | 'expired' | 'refunded';
export type Subscription = {
  provider: Provider;
  externalId: string;
  userId: string;
  status: SubscriptionStatus;
  planCode: string;
  expiresAt: number | null;
};

export class LicenseStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        app_account_token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        plan_code TEXT NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, external_id)
      );
      CREATE INDEX IF NOT EXISTS subscriptions_by_user ON subscriptions(user_id, status);
      CREATE TABLE IF NOT EXISTS webhook_events (
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (provider, event_id)
      );
    `);
  }

  createUser(email: string, salt: string, passwordHash: string): User {
    const user = { id: randomUUID(), email, passwordSalt: salt, passwordHash, appAccountToken: randomUUID() };
    this.db.prepare(`INSERT INTO users (id, email, password_salt, password_hash, app_account_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, user.email, user.passwordSalt, user.passwordHash, user.appAccountToken, Date.now());
    return { id: user.id, email: user.email, appAccountToken: user.appAccountToken };
  }

  findUserByEmail(email: string): (User & { passwordSalt: string; passwordHash: string }) | undefined {
    return this.db.prepare(`SELECT id, email, app_account_token AS appAccountToken,
      password_salt AS passwordSalt, password_hash AS passwordHash FROM users WHERE email = ? COLLATE NOCASE`).get(email) as
      (User & { passwordSalt: string; passwordHash: string }) | undefined;
  }

  findUserById(id: string): User | undefined {
    return this.db.prepare('SELECT id, email, app_account_token AS appAccountToken FROM users WHERE id = ?').get(id) as User | undefined;
  }

  findUserByAppAccountToken(token: string): User | undefined {
    return this.db.prepare('SELECT id, email, app_account_token AS appAccountToken FROM users WHERE app_account_token = ?').get(token) as User | undefined;
  }

  upsertSubscription(subscription: Subscription): void {
    this.db.prepare(`INSERT INTO subscriptions (provider, external_id, user_id, status, plan_code, expires_at, updated_at)
      VALUES (@provider, @externalId, @userId, @status, @planCode, @expiresAt, @updatedAt)
      ON CONFLICT(provider, external_id) DO UPDATE SET
        user_id = excluded.user_id,
        status = excluded.status,
        plan_code = excluded.plan_code,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`).run({ ...subscription, updatedAt: Date.now() });
  }

  hasWebhookEvent(provider: Provider, eventId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM webhook_events WHERE provider = ? AND event_id = ?').get(provider, eventId));
  }

  recordWebhookEvent(provider: Provider, eventId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO webhook_events (provider, event_id, received_at) VALUES (?, ?, ?)')
      .run(provider, eventId, Date.now());
  }

  entitlement(userId: string): { tier: 'free' | 'pro'; maxSlots: 1 | 4; providers: Provider[]; expiresAt: number | null } {
    const active = this.db.prepare(`SELECT provider, expires_at AS expiresAt FROM subscriptions
      WHERE user_id = ? AND (status = 'active' OR (status = 'cancelled' AND expires_at > ?))
      AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY COALESCE(expires_at, 9223372036854775807) DESC`).all(userId, Date.now(), Date.now()) as
      Array<{ provider: Provider; expiresAt: number | null }>;
    if (active.length === 0) return { tier: 'free', maxSlots: 1, providers: [], expiresAt: null };
    const expiries = active.map(item => item.expiresAt).filter((value): value is number => value !== null);
    return {
      tier: 'pro',
      maxSlots: 4,
      providers: [...new Set(active.map(item => item.provider))],
      expiresAt: expiries.length ? Math.max(...expiries) : null,
    };
  }

  close(): void {
    this.db.close();
  }
}
