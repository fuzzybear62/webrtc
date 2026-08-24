import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VideoRTC } from '../custom_components/webrtc/www/video-rtc.js';

// Behavioral tests for the autoplay mute-fallback fix (upstream PR #951).
//
// play() must fall back to muted playback ONLY on a real autoplay-policy block
// (NotAllowedError). Any other rejection must NOT permanently mute the video —
// that would silence audio for a non-audio reason (a transient decode error or a
// race during reconnect). AbortError is ignored outright, and an already-muted
// element must never re-enter the mute branch.
//
// We test the method in isolation: VideoRTC.prototype.play.call(fakeThis). play()
// only touches this.video and this.clientId, so we avoid constructing the custom
// element entirely.

/** Build a fake <video> whose play() returns queued promises (one per call). */
function makeVideo({ paused = true, muted = false, results = [] } = {}) {
  let call = 0;
  return {
    paused,
    muted,
    play: vi.fn(() => {
      const r = results[call++];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve();
    }),
  };
}

function err(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** Flush the microtask/macrotask queue so the nested .catch handlers run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('VideoRTC.play() mute-fallback (PR #951)', () => {
  let debugSpy;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('mutes and retries on NotAllowedError when unmuted', async () => {
    // 1st play() rejects with the autoplay-policy error, 2nd (muted) resolves.
    const video = makeVideo({ results: [err('NotAllowedError'), null] });
    VideoRTC.prototype.play.call({ clientId: 't', video });
    await flush();

    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it('does NOT mute on a non-autoplay rejection', async () => {
    const video = makeVideo({ results: [err('NotSupportedError')] });
    VideoRTC.prototype.play.call({ clientId: 't', video });
    await flush();

    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalled(); // logged, not muted
  });

  it('ignores AbortError (no mute, no log-as-rejection)', async () => {
    const video = makeVideo({ results: [err('AbortError')] });
    VideoRTC.prototype.play.call({ clientId: 't', video });
    await flush();

    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
    // early return before the "play() rejected" debug line
    const rejectedLog = debugSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('rejected')
    );
    expect(rejectedLog).toBeUndefined();
  });

  it('does not re-enter the mute branch when already muted', async () => {
    // NotAllowedError but the element is already muted -> else branch, no 2nd play.
    const video = makeVideo({ muted: true, results: [err('NotAllowedError')] });
    VideoRTC.prototype.play.call({ clientId: 't', video });
    await flush();

    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the video is not paused (top guard)', async () => {
    const video = makeVideo({ paused: false });
    VideoRTC.prototype.play.call({ clientId: 't', video });
    await flush();

    expect(video.play).not.toHaveBeenCalled();
  });

  it('is a no-op on successful play()', async () => {
    const video = makeVideo({ results: [null] });
    VideoRTC.prototype.play.call({ clientId: 't', video });
    await flush();

    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(1);
  });
});
