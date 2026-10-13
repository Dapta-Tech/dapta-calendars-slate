import { describe, expect, it } from 'vitest';
import { connectedPhotoOf, resolveAvatarUrl } from './avatar';

describe('resolveAvatarUrl', () => {
  it("the host's own photo wins over the connected one", () => {
    expect(resolveAvatarUrl('https://cdn.example.test/mine.png', 'https://cdn.example.test/synced.jpg')).toBe(
      'https://cdn.example.test/mine.png',
    );
  });
  it('falls back to the connected photo, and to nothing when it was removed (null)', () => {
    expect(resolveAvatarUrl('', 'https://cdn.example.test/synced.jpg')).toBe('https://cdn.example.test/synced.jpg');
    expect(resolveAvatarUrl('', null)).toBeNull();
  });
});

describe('connectedPhotoOf', () => {
  it('prefers the destination calendar, the account the host schedules from', () => {
    expect(
      connectedPhotoOf([
        { isDestination: false, avatarUrl: 'https://cdn.example.test/other.jpg' },
        { isDestination: true, avatarUrl: 'https://cdn.example.test/dest.jpg' },
      ]),
    ).toBe('https://cdn.example.test/dest.jpg');
  });
  it('takes any other connection with a photo when the destination has none', () => {
    expect(
      connectedPhotoOf([
        { isDestination: true, avatarUrl: null },
        { isDestination: false, avatarUrl: 'https://cdn.example.test/other.jpg' },
      ]),
    ).toBe('https://cdn.example.test/other.jpg');
  });
  it('ignores anything that is not an http(s) photo, and an older API with no field', () => {
    expect(connectedPhotoOf([{ isDestination: true, avatarUrl: 'javascript:alert(1)' }])).toBeNull();
    expect(connectedPhotoOf([{ isDestination: true }])).toBeNull();
    expect(connectedPhotoOf([])).toBeNull();
  });
});
