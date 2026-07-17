"""fm_paths - shared root/home resolution for firstmate eval-runner Python tools.

Mirrors sbin/fm-root-lib.sh for shell: separates the canonical code root
(derived from this file's own on-disk location, i.e. wherever the repo was
cloned) from the operational home that owns data/, state/, config/, and
projects/ (FM_HOME, defaulting to the code root when unset). This lets the
same scripts run unmodified for any cap's checkout or secondmate home,
with no machine-specific absolute paths baked in.
"""
from __future__ import annotations

import os
from pathlib import Path


def code_root() -> Path:
    """The checked-out firstmate repo root.

    This file lives at <repo>/benchmarks/eval-runner/fm_paths.py, so the repo
    root is two directories up. FM_CODE_ROOT_OVERRIDE (or the legacy
    FM_ROOT_OVERRIDE, matching fm-root-lib.sh) can force a different root.
    """
    override = os.environ.get("FM_CODE_ROOT_OVERRIDE") or os.environ.get("FM_ROOT_OVERRIDE")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parent.parent.parent


def fm_home() -> Path:
    """The operational home for data/, state/, config/, projects/.

    Defaults to the code root, matching fm-root-lib.sh's FM_HOME semantics:
    when FM_HOME is unset, the home is the repo root; when set, it points at
    a separate (e.g. secondmate) home.
    """
    home = os.environ.get("FM_HOME")
    if home:
        return Path(home).expanduser().resolve()
    return code_root()


def _override_or(env_var: str, default: Path) -> Path:
    override = os.environ.get(env_var)
    return Path(override).expanduser().resolve() if override else default


def data_dir() -> Path:
    return _override_or("FM_DATA_OVERRIDE", fm_home() / "data")


def state_dir() -> Path:
    return _override_or("FM_STATE_OVERRIDE", fm_home() / "state")


def config_dir() -> Path:
    return _override_or("FM_CONFIG_OVERRIDE", fm_home() / "config")


def projects_dir() -> Path:
    return _override_or("FM_PROJECTS_OVERRIDE", fm_home() / "projects")
