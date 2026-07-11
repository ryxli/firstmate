#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export FM_CRON_DROP_SCRIPT_DIR="$SCRIPT_DIR"
exec python3 - "$@" <<'PY'
"""Manage per-FM_HOME cron/launchd drop-ins.

V1 contract:
- desired state lives under $FM_HOME/state/cron.d/*.json
- each home reconciles only its own drops
- launchd plists are generated under ~/Library/LaunchAgents
- no drop may run a relative executable
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def env_value(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value else None


SCRIPT_DIR = Path(env_value("FM_CRON_DROP_SCRIPT_DIR") or Path(__file__).resolve().parent).resolve()
FM_ROOT = Path(env_value("FM_ROOT_OVERRIDE") or SCRIPT_DIR.parent).resolve()
FM_HOME = Path(env_value("FM_HOME") or env_value("FM_ROOT_OVERRIDE") or str(FM_ROOT)).resolve()
STATE = Path(env_value("FM_STATE_OVERRIDE") or FM_HOME / "state").resolve()
DROP_DIR = STATE / "cron.d"
HOME = Path(env_value("HOME") or str(Path.home())).resolve()
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
LABEL_PREFIX = "ai.blackforest.fm-cron"
HOME_HASH = hashlib.sha1(str(FM_HOME).encode()).hexdigest()[:10]


class DropError(Exception):
    pass


@dataclass(frozen=True)
class Drop:
    id: str
    enabled: bool
    kind: str
    command: list[str]
    schedule: dict[str, Any]
    env: dict[str, str]
    cwd: str | None
    owner: str
    scope: str
    notify_on: str
    path: Path

    @property
    def label(self) -> str:
        return f"{LABEL_PREFIX}.{HOME_HASH}.{self.id}"

    @property
    def plist_path(self) -> Path:
        return LAUNCH_AGENTS / f"{self.label}.plist"


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def ensure_dirs() -> None:
    DROP_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise DropError(f"{path}: invalid JSON: {exc}") from exc


def validate_drop(path: Path, data: dict[str, Any]) -> Drop:
    did = data.get("id")
    if not isinstance(did, str) or not did:
        raise DropError(f"{path}: id must be a non-empty string")
    if not all(c.isalnum() or c in "-_" for c in did):
        raise DropError(f"{path}: id may contain only letters, digits, '-' and '_'")

    enabled = bool(data.get("enabled", False))
    kind = data.get("kind", "daily")
    if kind not in {"daily", "watch"}:
        raise DropError(f"{path}: kind must be daily or watch")

    command = data.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
        raise DropError(f"{path}: command must be a non-empty string array")
    exe = Path(command[0])
    if not exe.is_absolute():
        raise DropError(f"{path}: command[0] must be an absolute path")

    schedule = data.get("schedule", {})
    if kind == "daily":
        if not isinstance(schedule, dict) or schedule.get("type") != "daily":
            raise DropError(f"{path}: daily drops need schedule.type=daily")
        hour = schedule.get("hour")
        minute = schedule.get("minute")
        if not isinstance(hour, int) or not 0 <= hour <= 23:
            raise DropError(f"{path}: schedule.hour must be 0..23")
        if not isinstance(minute, int) or not 0 <= minute <= 59:
            raise DropError(f"{path}: schedule.minute must be 0..59")
    elif kind == "watch":
        if not isinstance(schedule, dict) or schedule.get("type") != "watch":
            raise DropError(f"{path}: watch drops need schedule.type=watch")

    env = data.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise DropError(f"{path}: env must be an object of string values")
    cwd = data.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise DropError(f"{path}: cwd must be a string when set")

    return Drop(
        id=did,
        enabled=enabled,
        kind=kind,
        command=command,
        schedule=schedule,
        env=env,
        cwd=cwd,
        owner=str(data.get("owner", "unknown")),
        scope=str(data.get("scope", "unknown")),
        notify_on=str(data.get("notify_on", "failure")),
        path=path,
    )


def load_drops() -> list[Drop]:
    ensure_dirs()
    drops: list[Drop] = []
    for path in sorted(DROP_DIR.glob("*.json")):
        drops.append(validate_drop(path, load_json(path)))
    return drops


def write_drop(data: dict[str, Any]) -> Path:
    ensure_dirs()
    did = data["id"]
    path = DROP_DIR / f"{did}.json"
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    return path


def remove_drop(did: str) -> None:
    path = DROP_DIR / f"{did}.json"
    if path.exists():
        path.unlink()


def cost_daily_drop(enabled: bool) -> dict[str, Any]:
    return {
        "id": "cost-daily-refresh",
        "enabled": enabled,
        "kind": "daily",
        "owner": "ledger",
        "scope": "cost-savings",
        "schedule": {"type": "daily", "hour": 9, "minute": 15},
        "command": [str(FM_HOME / ".omp/extensions/fm-cost/fm-cost-run.sh")],
        "env": {"FM_HOME": str(FM_HOME)},
        "cwd": str(FM_HOME),
        "notify_on": "nonempty-status-or-failure",
    }


def cost_derived_drop(enabled: bool) -> dict[str, Any]:
    return {
        "id": "cost-derived-refresh",
        "enabled": enabled,
        "kind": "watch",
        "owner": "ledger",
        "scope": "cost-savings",
        "schedule": {
            "type": "watch",
            "paths": [
                str(FM_HOME / "data/cost-savings/timeseries.csv"),
                str(FM_HOME / "data/cost-savings/footprint.csv"),
                str(FM_HOME / "data/cost-savings/ledger.md"),
            ],
        },
        "command": [str(FM_HOME / ".omp/extensions/fm-cost/fm-cost-wbr.sh"), "current"],
        "env": {"FM_HOME": str(FM_HOME)},
        "cwd": str(FM_HOME),
        "notify_on": "failure",
    }


def plist_for(drop: Drop) -> dict[str, Any]:
    env = dict(drop.env)
    env.setdefault("FM_HOME", str(FM_HOME))
    return {
        "Label": drop.label,
        "ProgramArguments": drop.command,
        "EnvironmentVariables": env,
        "WorkingDirectory": drop.cwd or str(FM_HOME),
        "StartCalendarInterval": {
            "Hour": drop.schedule["hour"],
            "Minute": drop.schedule["minute"],
        },
        "StandardOutPath": str(STATE / f"{drop.id}.out"),
        "StandardErrorPath": str(STATE / f"{drop.id}.err"),
        "RunAtLoad": False,
    }


def run_launchctl(args: list[str], dry_run: bool) -> int:
    if dry_run:
        print("dry-run:", " ".join(["launchctl", *args]))
        return 0
    try:
        return subprocess.run(["launchctl", *args], check=False).returncode
    except FileNotFoundError:
        raise DropError("launchctl not found; this adapter currently supports macOS launchd")


def unload(drop: Drop, dry_run: bool) -> None:
    uid = str(os.getuid())
    run_launchctl(["bootout", f"gui/{uid}/{drop.label}"], dry_run)
    if dry_run:
        print(f"dry-run: remove {drop.plist_path}")
    else:
        drop.plist_path.unlink(missing_ok=True)


def install(drop: Drop, dry_run: bool) -> None:
    if drop.kind != "daily":
        print(f"skip: {drop.id} kind={drop.kind} has no launchd adapter in v1")
        return
    if not drop.enabled:
        unload(drop, dry_run)
        print(f"disabled: {drop.id}")
        return
    if dry_run:
        print(f"dry-run: write {drop.plist_path}")
    else:
        LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
        with drop.plist_path.open("wb") as f:
            plistlib.dump(plist_for(drop), f, sort_keys=False)
    uid = str(os.getuid())
    run_launchctl(["bootout", f"gui/{uid}/{drop.label}"], dry_run)
    code = run_launchctl(["bootstrap", f"gui/{uid}", str(drop.plist_path)], dry_run)
    if code != 0 and not dry_run:
        raise DropError(f"launchctl bootstrap failed for {drop.id} with exit {code}")
    print(f"enabled: {drop.id} -> {drop.label}")


def cmd_list(_args: argparse.Namespace) -> int:
    drops = load_drops()
    if not drops:
        print(f"cron-drop: no drops in {DROP_DIR}")
        return 0
    for d in drops:
        state = "enabled" if d.enabled else "disabled"
        if d.kind == "daily":
            when = f"daily {d.schedule['hour']:02d}:{d.schedule['minute']:02d}"
        else:
            paths = d.schedule.get("paths", [])
            when = f"watch {len(paths)} path(s)"
        print(f"{d.id}: {state}, {d.kind}, {when}, owner={d.owner}, scope={d.scope}")
    return 0


def cmd_mode(args: argparse.Namespace) -> int:
    mode = args.mode
    if mode == "off":
        write_drop(cost_daily_drop(False))
        write_drop(cost_derived_drop(False))
    elif mode == "derived":
        write_drop(cost_daily_drop(False))
        write_drop(cost_derived_drop(True))
    elif mode == "daily":
        write_drop(cost_daily_drop(True))
        write_drop(cost_derived_drop(True))
    else:
        die("mode must be off, derived, or daily", 2)
    print(f"mode: {mode}")
    return cmd_list(args)


def cmd_reconcile(args: argparse.Namespace) -> int:
    for d in load_drops():
        install(d, args.dry_run)
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    drops = load_drops()
    if not drops:
        print("cron-drop: no drops")
        return 0
    for d in drops:
        if d.kind != "daily":
            print(f"{d.id}: {d.kind}, desired={'enabled' if d.enabled else 'disabled'}, launchd=n/a")
            continue
        exists = d.plist_path.exists()
        print(f"{d.id}: desired={'enabled' if d.enabled else 'disabled'}, plist={'present' if exists else 'missing'}, label={d.label}")
    return 0


def cmd_write_example(args: argparse.Namespace) -> int:
    if args.name == "cost-daily":
        path = write_drop(cost_daily_drop(True))
    elif args.name == "cost-derived":
        path = write_drop(cost_derived_drop(True))
    else:
        die("example must be cost-daily or cost-derived", 2)
    print(f"wrote: {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Manage per-home cron drop-ins")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(func=cmd_list)
    sub.add_parser("status").set_defaults(func=cmd_status)
    m = sub.add_parser("mode")
    m.add_argument("mode", choices=["off", "derived", "daily"])
    m.set_defaults(func=cmd_mode)
    r = sub.add_parser("reconcile")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(func=cmd_reconcile)
    e = sub.add_parser("write-example")
    e.add_argument("name", choices=["cost-daily", "cost-derived"])
    e.set_defaults(func=cmd_write_example)
    return p


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except DropError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
PY
