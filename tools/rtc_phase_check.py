#!/usr/bin/env python3
"""
rtc_phase_check.py — validate the WebRTC driver RTC phase machine from a console log.

Consumes a Home Assistant browser-console export (the same kind we've been analysing)
and checks the invariants for driver v2.3.5+ (the explicit `_rtcPhase` machine):

  #3 FSM grammar   — every `RTC phase A -> B` edge is legal, and B chains into the next A.
  #4 per-camera    — each disposable driver runs one forward lifecycle; reports the outcome
                     (committed / reverted / rejected) so you can eyeball it against the net.
  #5 legacy canary — the removed dead-path markers must NEVER appear.

Net-agnostic: it does not assume which network the log is from. It reports each camera's
outcome and flags only real anomalies (illegal edge, phase desync, legacy marker, relapse).

Usage:
    python3 rtc_phase_check.py <logfile> [<logfile> ...]

Exit code 0 = all PASS, 1 = at least one FAIL. Warnings do not fail the run.
"""

import re
import sys

# ---- driver v2.3.5 phase machine -------------------------------------------------
LEGAL_EDGES = {
    ("warm", "negotiating"),
    ("negotiating", "promoted"),
    ("promoted", "committed"),
    ("promoted", "warm"),        # revert pre-commit (liveness stall / pc fail)
    ("negotiating", "warm"),     # revert before promote (backstop / reject / pc fail)
}
TERMINAL = {"warm", "committed"}
PHASES = {"warm", "negotiating", "promoted", "committed"}

# Markers of the DELETED legacy/non-reversible path — must never appear (#5 canary).
LEGACY_MARKERS = [
    "handing off",                 # old commitHandoff(): "RTC proven (...) — handing off"
    "Mode: RTC (Socket Closing)",  # old onpcvideo() irreversible switch
]

# ---- regexes ---------------------------------------------------------------------
RE_PHASE   = re.compile(r"\[VideoRTC:(\w+)\]\s+RTC phase (\w+) -> (\w+)")
RE_MODE    = re.compile(r"\[VideoRTC:(\w+)\]\s+Mode:\s+(\w+)")
RE_PROMOTE = re.compile(r"\[VideoRTC:(\w+)\]\s+RTC promoted \((\d+)ms flowing\) @(\d+)ms")
RE_COMMIT  = re.compile(r"\[VideoRTC:(\w+)\]\s+RTC stable \d+ms @(\d+)ms — committing")
RE_REVERT  = re.compile(r"\[VideoRTC:(\w+)\]\s+(.*?); reverting to warm MSE")
RE_REJECT  = re.compile(r"\[VideoRTC:(\w+)\]\s+RTC Rejected \(Priority < MSE\)")
# card-level context (no clientId in the log line)
RE_SWAP    = re.compile(r"Shadow RTC proven durable — SWAPPING DRIVERS NOW")
RE_DIRECT  = re.compile(r"Main Driver negotiated WebRTC directly")


class Cam:
    __slots__ = ("cid", "edges", "errors", "warns", "committed", "reverts",
                 "rejected", "promoted_ms")

    def __init__(self, cid):
        self.cid = cid
        self.edges = []          # list of (frm, to)
        self.errors = []
        self.warns = []
        self.committed = False
        self.reverts = 0
        self.rejected = False
        self.promoted_ms = None


def parse(path):
    cams = {}
    legacy_hits = []
    swaps = 0
    directs = 0

    def cam(cid):
        return cams.setdefault(cid, Cam(cid))

    with open(path, encoding="utf-8", errors="replace") as fh:
        for lineno, raw in enumerate(fh, 1):
            for marker in LEGACY_MARKERS:
                if marker in raw:
                    legacy_hits.append((lineno, marker, raw.strip()))

            m = RE_PHASE.search(raw)
            if m:
                cid, frm, to = m.group(1), m.group(2), m.group(3)
                cam(cid).edges.append((frm, to))
                continue

            m = RE_PROMOTE.search(raw)
            if m:
                cam(m.group(1)).promoted_ms = int(m.group(3))
                continue
            if RE_COMMIT.search(raw):
                cam(RE_COMMIT.search(raw).group(1)).committed = True
                continue
            if RE_REVERT.search(raw):
                cam(RE_REVERT.search(raw).group(1)).reverts += 1
                continue
            if RE_REJECT.search(raw):
                cam(RE_REJECT.search(raw).group(1)).rejected = True
                continue
            if RE_SWAP.search(raw):
                swaps += 1
                continue
            if RE_DIRECT.search(raw):
                directs += 1

    return cams, legacy_hits, swaps, directs


def validate_cam(c):
    """Fill c.errors / c.warns from its edge list (#3 grammar + #4 lifecycle)."""
    prev_to = "warm"          # every disposable driver starts in 'warm'
    seen_warm_negotiating = 0
    for i, (frm, to) in enumerate(c.edges):
        if frm not in PHASES or to not in PHASES:
            c.errors.append(f"edge {i}: unknown phase in {frm}->{to}")
            continue
        if (frm, to) not in LEGAL_EDGES:
            c.errors.append(f"edge {i}: ILLEGAL transition {frm}->{to}")
        if frm != prev_to:
            c.errors.append(
                f"edge {i}: phase DESYNC — expected from '{prev_to}', log says '{frm}'")
        if prev_to == "committed":
            c.errors.append(
                f"edge {i}: transition OUT of terminal 'committed' ({frm}->{to})")
        if (frm, to) == ("warm", "negotiating"):
            seen_warm_negotiating += 1
        prev_to = to

    if seen_warm_negotiating > 1:
        c.warns.append(
            f"{seen_warm_negotiating}x warm->negotiating on one clientId "
            "(a disposable driver should re-probe as a NEW clientId)")

    # cross-check the coarse markers against the phase terminal
    if c.edges:
        terminal = c.edges[-1][1]
        if terminal not in TERMINAL:
            c.warns.append(f"log ends mid-lifecycle in '{terminal}' (capture cut off?)")
        if c.committed and terminal != "committed":
            c.errors.append("saw 'committing' but phase never reached 'committed'")
        if terminal == "committed" and not c.committed:
            c.warns.append("phase 'committed' without a 'committing' line (log gap?)")


def outcome(c):
    if not c.edges:
        return "no-rtc (MSE only, never negotiated)"
    term = c.edges[-1][1]
    if term == "committed":
        p = f" promote@{c.promoted_ms}ms" if c.promoted_ms is not None else ""
        return f"COMMITTED{p}"
    if c.rejected:
        return "REJECTED (RTC quality < MSE) -> warm"
    if term == "warm":
        return f"REVERTED x{c.reverts} -> warm (stayed on MSE)"
    return f"mid-lifecycle '{term}'"


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2

    overall_ok = True
    for path in argv[1:]:
        print(f"\n=== {path} ===")
        try:
            cams, legacy_hits, swaps, directs = parse(path)
        except OSError as e:
            print(f"  cannot read: {e}")
            overall_ok = False
            continue

        for c in cams.values():
            validate_cam(c)

        # #5 legacy canary (global)
        if legacy_hits:
            overall_ok = False
            print(f"  [#5 legacy] FAIL — {len(legacy_hits)} dead-path marker(s):")
            for ln, marker, txt in legacy_hits[:5]:
                print(f"      line {ln}: {marker!r}  ::  {txt}")
        else:
            print("  [#5 legacy] PASS — no removed-path markers present")

        # per-camera table
        if not cams:
            print("  no [VideoRTC:*] driver lines found — is this a webrtc console log?")
            overall_ok = False
        for cid in sorted(cams):
            c = cams[cid]
            seq = " -> ".join([c.edges[0][0]] + [t for _, t in c.edges]) if c.edges else "(none)"
            verdict = "FAIL" if c.errors else ("WARN" if c.warns else "PASS")
            if c.errors:
                overall_ok = False
            print(f"  [{cid}] {verdict:4} | {outcome(c)}")
            print(f"          phases: {seq}")
            for e in c.errors:
                print(f"          ERROR: {e}")
            for w in c.warns:
                print(f"          warn:  {w}")

        print(f"  context: {len(cams)} camera(s), "
              f"{directs} direct-RTC, {swaps} shadow-swap(s)")

    print("\n" + ("ALL PASS" if overall_ok else "FAIL — see errors above"))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
