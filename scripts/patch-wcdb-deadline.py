#!/usr/bin/env python3
"""Extend hardcoded WeFlow WCDB library software deadline (Docker / long-run).

libwcdb_api.so embeds:
  1) InitProtection: time() > 0x6ABDA27F  -> -101  (2026-09-30 23:59:59 UTC)
  2) wcdb_init: mktime(tm 2026-09-30 23:59:59) < time() -> -1000 + self-destruct log

Skipping InitProtection in JS is not enough; wcdb_init still enforces (2).

Usage:
  python3 scripts/patch-wcdb-deadline.py [path-to-libwcdb_api.so]
  python3 scripts/patch-wcdb-deadline.py --check [path]
  python3 scripts/patch-wcdb-deadline.py --year 2099 [path]

Default target year end: 2099-12-31 23:59:59 (local tm + UTC constant).
Creates sibling .deadline-orig backup once if missing.
"""

from __future__ import annotations

import argparse
import pathlib
import struct
import sys
from datetime import datetime, timezone

OLD_DEADLINE_UTC = 0x6ABDA27F  # 2026-09-30 23:59:59 UTC
# Embedded tm used by wcdb_init (glibc layout: sec,min,hour,mday then mon,year)
OLD_TM_HEAD = struct.pack("<4i", 59, 59, 23, 30)  # 2026-09-30 23:59:59
OLD_TM_TAIL = struct.pack("<2i", 8, 126)  # mon=Sep(8), year=2026-1900


def default_so_paths() -> list[pathlib.Path]:
    root = pathlib.Path(__file__).resolve().parents[1]
    return [
        root / "resources/wcdb/linux/x64/libwcdb_api.so",
        root / "release/linux-unpacked/resources/resources/wcdb/linux/x64/libwcdb_api.so",
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


def inspect(data: bytes) -> dict:
    c_old = data.count(struct.pack("<I", OLD_DEADLINE_UTC))
    c_head = data.count(OLD_TM_HEAD)
    c_tail = data.count(OLD_TM_TAIL)
    # paired layout used by current linux x64 build
    paired = 0
    start = 0
    while True:
        i = data.find(OLD_TM_HEAD, start)
        if i < 0:
            break
        # mon/year may sit at +0x1c8 relative in rodata; also accept immediate tail elsewhere
        if data[i + 0x1C8 : i + 0x1C8 + 8] == OLD_TM_TAIL:
            paired += 1
        start = i + 1
    return {
        "size": len(data),
        "deadline_const_old": c_old,
        "tm_head_old": c_head,
        "tm_tail_old": c_tail,
        "tm_paired_layout": paired,
        "already_patched": c_old == 0 and paired == 0,
    }


def build_new_values(year: int) -> tuple[int, bytes, bytes]:
    if year < 2027 or year > 2100:
        raise SystemExit("--year must be 2027..2100")
    # UTC instant for InitProtection cmp
    deadline_utc = int(datetime(year, 12, 31, 23, 59, 59, tzinfo=timezone.utc).timestamp())
    if deadline_utc > 0xFFFFFFFF:
        raise SystemExit("deadline does not fit uint32 imm (pick earlier year)")
    tm_head = struct.pack("<4i", 59, 59, 23, 31)  # Dec 31 23:59:59
    tm_tail = struct.pack("<2i", 11, year - 1900)  # mon=Dec
    return deadline_utc, tm_head, tm_tail


def patch(data: bytearray, year: int) -> tuple[int, dict]:
    info = inspect(bytes(data))
    if info["already_patched"] and info["deadline_const_old"] == 0:
        # idempotent: if old const gone, assume done
        return 0, info

    new_dl, new_head, new_tail = build_new_values(year)
    changes = 0

    old_dl = struct.pack("<I", OLD_DEADLINE_UTC)
    new_dl_b = struct.pack("<I", new_dl)
    if old_dl not in data:
        if info["tm_paired_layout"] == 0 and OLD_TM_HEAD not in data:
            return 0, {**info, "note": "no known markers; skip"}
    else:
        data[:] = data.replace(old_dl, new_dl_b)
        changes += info["deadline_const_old"]

    # Prefer exact layout: head at X, tail at X+0x1c8 (linux x64 current build)
    start = 0
    paired_hits = 0
    while True:
        i = data.find(OLD_TM_HEAD, start)
        if i < 0:
            break
        j = i + 0x1C8
        if data[j : j + 8] == OLD_TM_TAIL:
            data[i : i + 16] = new_head
            data[j : j + 8] = new_tail
            paired_hits += 1
            changes += 1
            start = j + 8
        else:
            start = i + 1

    if paired_hits == 0 and OLD_TM_HEAD in data and OLD_TM_TAIL in data:
        # fallback: independent replace (only if unique-ish)
        if data.count(OLD_TM_HEAD) == 1 and data.count(OLD_TM_TAIL) >= 1:
            data[:] = data.replace(OLD_TM_HEAD, new_head, 1)
            data[:] = data.replace(OLD_TM_TAIL, new_tail, 1)
            changes += 1

    return changes, {
        **inspect(bytes(data)),
        "new_deadline_utc": new_dl,
        "new_deadline_iso": datetime.fromtimestamp(new_dl, tz=timezone.utc).isoformat(),
        "paired_patched": paired_hits,
        "changes": changes,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Patch WCDB native deadline for long-run Docker")
    ap.add_argument("path", nargs="?", help="path to libwcdb_api.so")
    ap.add_argument("--check", action="store_true", help="inspect only")
    ap.add_argument("--year", type=int, default=2099, help="extend deadline to YEAR-12-31 (default 2099)")
    ap.add_argument("--no-backup", action="store_true")
    args = ap.parse_args()

    so = find_so(args.path)
    raw = so.read_bytes()
    info = inspect(raw)
    print(f"file: {so}")
    print(f"inspect: {info}")

    if args.check:
        sys.exit(0 if info["deadline_const_old"] >= 1 or info["already_patched"] else 1)

    if info["already_patched"] and info["deadline_const_old"] == 0:
        print("already patched (old deadline constant absent); ok")
        sys.exit(0)

    buf = bytearray(raw)
    n, result = patch(buf, args.year)
    if n <= 0:
        print(f"nothing patched: {result}", file=sys.stderr)
        sys.exit(2)

    if not args.no_backup:
        bak = so.with_suffix(so.suffix + ".deadline-orig")
        if not bak.exists():
            bak.write_bytes(raw)
            print(f"backup: {bak}")

    so.write_bytes(buf)
    print(f"patched ok: {result}")


if __name__ == "__main__":
    main()
