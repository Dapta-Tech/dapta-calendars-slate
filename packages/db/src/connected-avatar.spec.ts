import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAccountByCode, getMember, getPublicProfile } from './repository';
import { createConnection, setConnectionAvatar } from './parity';

/**
 * The avatar precedence the public page draws through.
 *
 * The rule is that a host's own choice always wins, and that a synced photo is
 * only ever a FALLBACK carried beside it — never written onto `member.avatar_url`,
 * because that column feeds the studio's own input and a sync landing in it would
 * silently turn a fallback into a saved value that outlives the connection.
 */
describe('connected-account avatar (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const account = await getAccountByCode(db, 'acme');
    accountId = account!.id;
    const member = await getMember(db, accountId, 'alex-rivera');
    memberId = member!.id;
    // The seed gives the demo host a photo; these cases are about what happens
    // when they have not chosen one.
    await db.run(sql`UPDATE member SET avatar_url = NULL WHERE id = ${memberId}`);
  });

  const connect = (externalId: string, avatarUrl: string | null, isDestination = false) =>
    createConnection(db, {
      accountId,
      memberId,
      provider: 'google',
      externalId,
      avatarUrl,
      isDestination,
    });

  it('falls back to the connected account photo when the host set none', async () => {
    await connect('conn-A', 'https://cdn.example.test/a.jpg');
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    expect(profile!.member.avatarUrl).toBeNull();
    expect(profile!.member.connectedAvatarUrl).toBe('https://cdn.example.test/a.jpg');
  });

  it("does not look one up once the host has chosen their own", async () => {
    await connect('conn-A', 'https://cdn.example.test/a.jpg');
    await db.run(sql`UPDATE member SET avatar_url = 'https://cdn.example.test/mine.png' WHERE id = ${memberId}`);
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    expect(profile!.member.avatarUrl).toBe('https://cdn.example.test/mine.png');
    // The host's choice is the answer, so the fallback is not even fetched.
    expect(profile!.member.connectedAvatarUrl).toBeNull();
  });

  it('prefers the destination connection over the others', async () => {
    await connect('conn-A', 'https://cdn.example.test/other.jpg');
    await connect('conn-B', 'https://cdn.example.test/destination.jpg', true);
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    expect(profile!.member.connectedAvatarUrl).toBe('https://cdn.example.test/destination.jpg');
  });

  it('stays null when the backend reports no photo', async () => {
    await connect('conn-A', null, true);
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    expect(profile!.member.connectedAvatarUrl).toBeNull();
  });

  it('takes a photo that only appears after the connection was made', async () => {
    await connect('conn-A', null, true);
    await setConnectionAvatar(db, accountId, memberId, 'conn-A', 'https://cdn.example.test/late.jpg');
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    expect(profile!.member.connectedAvatarUrl).toBe('https://cdn.example.test/late.jpg');
  });

  it('will not let another account write over the photo', async () => {
    await connect('conn-A', 'https://cdn.example.test/mine.jpg', true);
    await setConnectionAvatar(db, 'some-other-account', memberId, 'conn-A', 'https://cdn.example.test/theirs.jpg');
    const profile = await getPublicProfile(db, 'acme', 'alex-rivera');
    expect(profile!.member.connectedAvatarUrl).toBe('https://cdn.example.test/mine.jpg');
  });

  it('never writes the synced photo onto the member', async () => {
    await connect('conn-A', 'https://cdn.example.test/a.jpg', true);
    await getPublicProfile(db, 'acme', 'alex-rivera');
    const rows = await db.all<{ avatar_url: string | null }>(
      sql`SELECT avatar_url FROM member WHERE id = ${memberId}`,
    );
    expect(rows[0]!.avatar_url).toBeNull();
  });
});
