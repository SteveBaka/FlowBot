#!/usr/bin/env python3
"""Patch hardcoded WeFlow WCDB library software deadline (Docker / long-run).

libwcdb_api.so embeds two gates:
  1) InitProtection: time() > <UTC uint32 imm>  -> -101
  2) wcdb_init: mktime(<embedded tm>) < time()  -> -1000 + self-destruct log

JS never calls InitProtection, but wcdb_init still enforces (2). mktime() interprets the
embedded tm in the **process local timezone**, so the tm written here is the target UTC
instant expressed in the container timezone (TZ=Asia/Shanghai, docker/Dockerfile ENV)
=> default local offset +08:00. The uint32 constant is written as the same instant in UTC,
so both gates trip at the same moment regardless of which one is consulted.

Target deadline = the local-attestation cap (docs/dev/ATTEST.md). After that instant a
fresh wcdb_init() returns -1000 and every DB-backed feature stops. The attestation itself
does not hard-block a running process; the native gate takes effect on the next
(re)initialize (e.g. container restart) — by design.

Usage:
  python3 scripts/patch-wcdb-deadline.py [path]                # patch to attest_core cap
  python3 scripts/patch-wcdb-deadline.py --check [path]         # verify target markers

The target instant is read from the `attest_core` binary (its cap is the single source);
there is no override and no rollback path — this file holds no copy of the deadline value.

Recognised source markers: upstream original, legacy 2099 patch, any previously written
value (fixed-layout read), plus a paired-layout heuristic scan, so an old build is always
brought forward to the current cap. Only the paired layout (tm tail at head+0x1C8) is
modified; every changed byte must fall inside a marker we intentionally rewrote.
Creates sibling .deadline-orig backup once if missing (对照用).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

# mktime() local timezone of the container (docker/Dockerfile: ENV TZ=Asia/Shanghai)
DEFAULT_TM_OFFSET = "+08:00"

# The deadline instant itself is NOT stored here: it is read from the `attest_core`
# binary (single source of the attestation cap). There is deliberately no CLI override,
# so no file in this repository can point the native gate at another moment.
ATTEST_CORE_CANDIDATES = [
    pathlib.Path("/opt/weflow/resources/resources/attest/linux/x64/attest_core"),
    pathlib.Path("/opt/weflow/resources/attest/linux/x64/attest_core"),
]
EXTRA_ATTEST_CORE = [
    pathlib.Path(__file__).resolve().parents[1]
    / "resources/attest/linux/x64/attest_core",
    pathlib.Path(__file__).resolve().parents[1] / "docs/dev/attest_core/attest_core",
]

# paired layout used by this linux x64 build: tm tail sits 0x1C8 after tm head
TM_TAIL_DELTA = 0x1C8

# known deadline *instants* whose markers may be embedded in the .so
# (values come from the binary markers themselves; used only to *recognise* old states)
KNOWN_INSTANTS: list[tuple[str, int]] = [
    ("upstream-2026-09-30T23:59:59Z", 0x6ABDA27F),
    ("legacy-2099-12-31T23:59:59Z", 4102444799),
]

# fixed marker locations of this committed build (11820040 bytes): lets *any* past retarget
# be recognised even when its values are not in KNOWN_INSTANTS. Values are sanity-checked
# (epoch window / plausible calendar fields) before being treated as a deadline marker.
LAYOUT_SIZE = 11820040
LAYOUT_U32_OFFSET = 973930
LAYOUT_TM_OFFSET = 8278016
U32_MIN_EPOCH = 1577836800  # 2020-01-01
U32_MAX_EPOCH = 4133980799  # 2106-01-01 (uint32 range end)


def default_so_paths() -> list[pathlib.Path]:
    root = pathlib.Path(__file__).resolve().parents[1]
    return [
        root / "resources/wcdb/linux/x64/libwcdb_api.so",
        root
        / "release/linux-unpacked/resources/resources/wcdb/linux/x64/libwcdb_api.so",
        pathlib.Path("/opt/weflow/resources/resources/wcdb/linux/x64/libwcdb_api.so"),
    ]


def find_so(explicit: str | None) -> pathlib.Path:
    if explicit:
        p = pathlib.Path(explicit)
        if not p.is_file():
            raise SystemExit(f"not found: {p}")
        return p
    for p in default_so_paths():
        if p.is_file():
            return p
    raise SystemExit("libwcdb_api.so not found; pass path explicitly")


def parse_offset(text: str) -> timezone:
    s = text.strip()
    if s in ("Z", "z", "+00:00", "UTC", "utc"):
        return timezone.utc
    if s[0] not in "+-" or len(s) < 4:
        raise SystemExit(f"bad --tm-offset {text!r} (expected +08:00 style)")
    sign = 1 if s[0] == "+" else -1
    hh = int(s[1:3])
    mm = int(s[4:6]) if len(s) >= 6 else 0
    return timezone(sign * timedelta(hours=hh, minutes=mm))


def tm_forms(ts: int, tz: timezone) -> list[tuple[str, bytes, bytes]]:
    """Possible tm spellings for an instant: historical UTC-wall-clock form + local form."""
    forms: list[tuple[str, bytes, bytes]] = []
    seen: set[tuple[bytes, bytes]] = set()
    for label, dt in (
        ("utc-wall", datetime.fromtimestamp(ts, timezone.utc)),
        ("local", datetime.fromtimestamp(ts, tz)),
    ):
        head = struct.pack("<4i", dt.second, dt.minute, dt.hour, dt.day)
        tail = struct.pack("<2i", dt.month - 1, dt.year - 1900)
        if (head, tail) in seen:
            continue
        seen.add((head, tail))
        forms.append((label, head, tail))
    return forms


def target_pair(ts: int, tz: timezone) -> tuple[bytes, bytes]:
    """tm we write: mktime() semantics => local wall clock of the target instant."""
    for label, head, tail in tm_forms(ts, tz):
        if label == "local":
            return head, tail
    raise AssertionError


def source_sets(ts: int, tz: timezone) -> list[tuple[str, int, bytes, bytes]]:
    """Markers possibly present in the file that must be replaced (identity excluded)."""
    t_head, t_tail = target_pair(ts, tz)
    out: list[tuple[str, int, bytes, bytes]] = []
    seen: set[tuple[int, bytes, bytes]] = set()
    for name, k_ts in list(KNOWN_INSTANTS) + [("current-target", ts)]:
        for label, head, tail in tm_forms(k_ts, tz):
            if k_ts == ts and (head, tail) == (t_head, t_tail):
                continue
            key = (k_ts, head, tail)
            if key in seen:
                continue
            seen.add(key)
            out.append((f"{name}[{label}]", k_ts, head, tail))
    return out


def find_pairs(data: bytes, head: bytes, tail: bytes) -> list[int]:
    hits: list[int] = []
    start = 0
    while True:
        i = data.find(head, start)
        if i < 0:
            break
        if data[i + TM_TAIL_DELTA : i + TM_TAIL_DELTA + 8] == tail:
            hits.append(i)
        start = i + 1
    return hits


def layout_markers(data: bytes) -> tuple[int | None, tuple[bytes, bytes] | None]:
    """(u32 deadline value, tm pair) read from the fixed layout, if size + sanity match."""
    if len(data) != LAYOUT_SIZE:
        return None, None
    u = struct.unpack_from("<I", data, LAYOUT_U32_OFFSET)[0]
    u_ok = U32_MIN_EPOCH <= u <= U32_MAX_EPOCH
    sec, mn, hr, md = struct.unpack_from("<4i", data, LAYOUT_TM_OFFSET)
    j = LAYOUT_TM_OFFSET + TM_TAIL_DELTA
    mon, yr = struct.unpack_from("<2i", data, j)
    tm_ok = (
        sec <= 60
        and mn <= 59
        and 0 <= hr <= 23
        and 1 <= md <= 31
        and 0 <= mon <= 11
        and 100 <= yr <= 210
    )
    head = data[LAYOUT_TM_OFFSET : LAYOUT_TM_OFFSET + 16]
    tail = data[j : j + 8]
    return (u if u_ok else None), ((head, tail) if tm_ok else None)


def deadline_pairs(
    data: bytes, ts: int, tz: timezone
) -> list[tuple[int, bytes, bytes]]:
    """Every paired-layout tm that looks like a deadline stamp: (offset, head, tail).

    Two sources, unioned by offset:
      * heuristic scan — sec=59,min=59, plausible date, tail at +0x1C8 (measured: exactly
        one hit in this .so, i.e. the deadline tm itself) => catches *any* past retarget
        whose seconds/minutes are 59;
      * exact known forms from KNOWN_INSTANTS (both utc-wall and local spellings).
    The fixed layout (LAYOUT_TM_OFFSET) is handled separately by inspect/patch.
    """
    out: dict[int, tuple[bytes, bytes]] = {}
    start = 0
    probe = struct.pack("<2i", 59, 59)
    while True:
        i = data.find(probe, start)
        if i < 0:
            break
        if i + 16 <= len(data):
            sec, mn, hr, md = struct.unpack_from("<4i", data, i)
            if hr <= 23 and 1 <= md <= 31:
                j = i + TM_TAIL_DELTA
                if j + 8 <= len(data):
                    mon, yr = struct.unpack_from("<2i", data, j)
                    if 0 <= mon <= 11 and 100 <= yr <= 210:
                        out[i] = (data[i : i + 16], data[j : j + 8])
        start = i + 1
    for _name, _k_ts, head, tail in source_sets(ts, tz):
        for i in find_pairs(data, head, tail):
            out.setdefault(i, (head, tail))
    return [(i, h, t) for i, (h, t) in sorted(out.items())]


def inspect(data: bytes, ts: int, tz: timezone) -> dict:
    u32 = struct.pack("<I", ts)
    t_head, t_tail = target_pair(ts, tz)

    foreign_u32: list[str] = []
    for name, k_ts, _head, _tail in source_sets(ts, tz):
        if (
            k_ts != ts
            and data.count(struct.pack("<I", k_ts))
            and name not in foreign_u32
        ):
            foreign_u32.append(name)

    pairs = deadline_pairs(data, ts, tz)
    foreign_pairs = [p for p in pairs if (p[1], p[2]) != (t_head, t_tail)]

    # fixed layout catches any past retarget value (including non-59 second forms)
    lu32, ltm = layout_markers(data)
    if lu32 is not None and lu32 != ts:
        foreign_u32.append(f"layout-u32@{LAYOUT_U32_OFFSET}={lu32}")
    if ltm is not None and ltm != (t_head, t_tail):
        if LAYOUT_TM_OFFSET not in [p[0] for p in foreign_pairs]:
            foreign_pairs.append((LAYOUT_TM_OFFSET, ltm[0], ltm[1]))

    target_u32 = data.count(u32)
    target_pairs = len(find_pairs(data, t_head, t_tail))
    at_target = (
        target_u32 >= 1 and target_pairs >= 1 and not foreign_u32 and not foreign_pairs
    )
    return {
        "size": len(data),
        "target_utc": ts,
        "target_utc_iso": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
        "target_tm_local": datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d %H:%M:%S"),
        "target_u32_count": target_u32,
        "target_tm_pair_count": target_pairs,
        "layout_u32": lu32,
        "foreign_u32": foreign_u32 or ["none"],
        "foreign_tm_pairs": len(foreign_pairs),
        "at_target": at_target,
    }


def diff_ranges(a: bytes, b: bytes) -> list[tuple[int, int]]:
    if len(a) != len(b):
        return [(-1, -1)]
    ranges: list[tuple[int, int]] = []
    i = 0
    n = len(a)
    while i < n:
        if a[i] != b[i]:
            j = i
            while j < n and a[j] != b[j]:
                j += 1
            ranges.append((i, j))
            i = j
        else:
            i += 1
    return ranges


def merge_ranges(rs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not rs:
        return []
    rs = sorted(rs)
    out = [list(rs[0])]
    for s, e in rs[1:]:
        if s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def patch(raw: bytes, ts: int, tz: timezone) -> tuple[bytes, int, dict]:
    """Return (patched bytes, changes, info). Raises SystemExit on unsafe/no-op result."""
    data = bytearray(raw)
    t_head, t_tail = target_pair(ts, tz)
    new_u32 = struct.pack("<I", ts)
    changes = 0
    notes: list[str] = []
    allowed: list[tuple[int, int]] = []

    # 1) uint32 constant (InitProtection) — only when it differs from target
    for name, k_ts, _head, _tail in source_sets(ts, tz):
        if k_ts == ts:
            continue
        old_u32 = struct.pack("<I", k_ts)
        pos = 0
        while True:
            i = data.find(old_u32, pos)
            if i < 0:
                break
            allowed.append((i, i + 4))
            pos = i + 1
        n = data.count(old_u32)
        if n:
            data[:] = data.replace(old_u32, new_u32)
            changes += n
            notes.append(f"u32 {name} x{n} -> {ts}")

    # 1b) fixed layout: catches an unknown past value (not in KNOWN_INSTANTS)
    lu32, _ltm = layout_markers(bytes(data))
    if lu32 is not None and lu32 != ts:
        data[LAYOUT_U32_OFFSET : LAYOUT_U32_OFFSET + 4] = new_u32
        allowed.append((LAYOUT_U32_OFFSET, LAYOUT_U32_OFFSET + 4))
        changes += 1
        notes.append(f"u32 layout@{LAYOUT_U32_OFFSET} {lu32} -> {ts}")

    # 2) tm pair (wcdb_init mktime) — paired layout only, never a blind replace
    for i, head, tail in deadline_pairs(bytes(data), ts, tz):
        if (head, tail) == (t_head, t_tail):
            continue
        j = i + TM_TAIL_DELTA
        data[i : i + 16] = t_head
        data[j : j + 8] = t_tail
        allowed.append((i, i + 16))
        allowed.append((j, j + 8))
        changes += 1
        notes.append(f"tm_pair @{i} ({head.hex()}.. -> target)")

    # 2b) fixed layout tm: catches non-59-second past values the heuristic scan misses
    _lu32b, ltm = layout_markers(bytes(data))
    if ltm is not None and ltm != (t_head, t_tail):
        i = LAYOUT_TM_OFFSET
        j = i + TM_TAIL_DELTA
        data[i : i + 16] = t_head
        data[j : j + 8] = t_tail
        allowed.append((i, i + 16))
        allowed.append((j, j + 8))
        changes += 1
        notes.append(f"tm_pair layout@{i}")

    info = inspect(bytes(data), ts, tz)
    if changes <= 0:
        raise SystemExit(f"nothing patched (no recognised markers): {info}")
    if not info["at_target"]:
        raise SystemExit(f"patch incomplete, refusing to write: {info}")

    # precise safety: every changed byte must live inside a marker we intentionally rewrote
    ranges = diff_ranges(raw, bytes(data))
    allowed_m = merge_ranges(allowed)
    stray = [
        r for r in ranges if not any(r[0] >= a and r[1] <= b for a, b in allowed_m)
    ]
    if stray:
        raise SystemExit(f"refusing to write: changes outside marker ranges: {stray}")
    return (
        bytes(data),
        changes,
        {**info, "changes": changes, "changed_ranges": ranges, "notes": notes},
    )


def cap_from_attest_core(explicit: str | None) -> tuple[int, str]:
    """Read the attestation cap (single source) from the attest_core binary."""
    cands: list[pathlib.Path] = []
    if explicit:
        cands.append(pathlib.Path(explicit))
    else:
        cands += ATTEST_CORE_CANDIDATES + EXTRA_ATTEST_CORE
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    tried: list[str] = []
    for p in cands:
        tried.append(str(p))
        if not p.is_file():
            continue
        cap = _lease_cap(p, now_ms)
        if cap is None:
            # the repo may track the binary as 100644: retry through an exec-able copy
            tmp = _exec_copy(p)
            try:
                cap = _lease_cap(tmp, now_ms)
            finally:
                try:
                    tmp.unlink()
                except OSError:
                    pass
        if cap is not None:
            return cap // 1000, str(p)
    raise SystemExit(
        f"attest_core not found/unusable, cannot derive deadline; tried: {tried}"
    )


def _lease_cap(bin_path: pathlib.Path, now_ms: int) -> int | None:
    try:
        out = subprocess.run(
            [str(bin_path), "lease", str(now_ms)],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
        cap = json.loads(out).get("cap_ms")
        return cap if isinstance(cap, int) and cap > 0 else None
    except Exception:
        return None


def _exec_copy(p: pathlib.Path) -> pathlib.Path:
    """Temp copy with the exec bit set (repo may track 100644)."""
    fd, tmp = tempfile.mkstemp(prefix="attest_core_")
    os.close(fd)
    dst = pathlib.Path(tmp)
    shutil.copyfile(p, dst)
    dst.chmod(0o755)
    return dst


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Patch WCDB native deadline (aligned to attest cap)"
    )
    ap.add_argument("path", nargs="?", help="path to libwcdb_api.so")
    ap.add_argument(
        "--check", action="store_true", help="verify target markers, do not write"
    )
    ap.add_argument(
        "--attest-core", default=None, help="path to attest_core binary (default: auto)"
    )
    ap.add_argument(
        "--tm-offset",
        default=DEFAULT_TM_OFFSET,
        help=f"local offset for the mktime tm (default {DEFAULT_TM_OFFSET} = container TZ)",
    )
    ap.add_argument("--no-backup", action="store_true")
    args = ap.parse_args()

    ts, bin_path = cap_from_attest_core(args.attest_core)
    source = f"attest_core {bin_path}"

    tz = parse_offset(args.tm_offset)
    target_desc = datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    so = find_so(args.path)
    raw = so.read_bytes()
    info = inspect(raw, ts, tz)
    print(f"file: {so}")
    print(f"target: {target_desc} (source: {source})")
    print(f"inspect: {info}")

    if args.check:
        if not info["at_target"]:
            print(
                f"CHECK FAILED: markers are not at target {target_desc}",
                file=sys.stderr,
            )
        sys.exit(0 if info["at_target"] else 1)

    if info["at_target"]:
        print(f"already at target ({target_desc}); ok")
        sys.exit(0)

    patched, n, result = patch(raw, ts, tz)

    if not args.no_backup:
        bak = so.with_suffix(so.suffix + ".deadline-orig")
        if not bak.exists():
            bak.write_bytes(raw)
            print(f"backup: {bak}")

    so.write_bytes(patched)
    print(f"patched ok: {result}")


if __name__ == "__main__":
    main()
