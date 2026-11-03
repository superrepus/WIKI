"""Compatibility entry point for the original r5 offline verifier command."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("Test-Offline-Installer.py")), run_name="__main__")
