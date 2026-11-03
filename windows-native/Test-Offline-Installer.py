"""Verify the current installer without starting the app or contacting any service.

Run after Build-Installer.py from a Windows development checkout. All extraction,
synthetic provisioning and uninstall operations are confined to a new directory
under this checkout's .installer-tests. Existing installations and profiles are
never used. Local private files are read only to detect accidental credentials in
packaged text/source; their values and subprocess output are never printed.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import subprocess
import sys
import uuid
import zipfile


ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "windows-native/runtime"
BUILD_INFO = json.loads((RUNTIME / "installer-build.json").read_text(encoding="utf-8-sig"))
RELEASE = Path(BUILD_INFO["installer"]).resolve().parent
BUILD_PATH = RUNTIME / "installer-build.json"
CANDIDATE = Path(BUILD_INFO.get("executable", ROOT / "native-tools/target/debug/llm-wiki.exe"))
VERSION = BUILD_INFO.get("version", "0.6.13+foxess.20261103.r5")
TEXT_SUFFIXES = {".json", ".md", ".js", ".mjs", ".ps1", ".cmd", ".txt", ".html", ".css", ".nsi", ".nsh"}
SOURCE_BINARY_SUFFIXES = {".exe", ".dll", ".so", ".dylib", ".pdb"}


class VerificationFailure(RuntimeError):
    """Contains a fixed diagnostic label only, never private file contents."""


def require(condition: bool, label: str) -> None:
    if not condition:
        raise VerificationFailure(label)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    require(isinstance(value, dict), "Expected a JSON object")
    return value


def inside(path: Path, parent: Path) -> bool:
    return path.resolve().is_relative_to(parent.resolve())


def payload_path(target: Path, relative: str) -> Path:
    require(isinstance(relative, str) and bool(relative), "Invalid payload path")
    normalized = relative.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    require(not PurePosixPath(normalized).is_absolute() and all(part not in ("", ".", "..") and ":" not in part for part in parts), "Unsafe payload path")
    result = target.joinpath(*parts)
    require(inside(result, target), "Payload path escaped the extraction directory")
    return result


def run_hidden(command: list[str] | str, *, timeout: int) -> subprocess.CompletedProcess:
    # No shell, startup scripts, interactive window, app launch, CLI or API calls.
    environment = {name: value for name, value in os.environ.items() if name.upper() != "PSMODULEPATH"}
    return subprocess.run(command, cwd=ROOT, env=environment, check=True, timeout=timeout,
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          creationflags=subprocess.CREATE_NO_WINDOW)


def nsis_command(executable: Path, switches: str, final_argument: str) -> str:
    # NSIS requires /D= and _?= to be final and unquoted, including spaces.
    return subprocess.list2cmdline([str(executable)]) + " " + switches + " " + final_argument


def credential_needles(public_model: dict) -> tuple[list[bytes], int]:
    """Same private sources as Test-Installer.py; never return values in reports."""
    values: list[str] = []
    inspected = 0
    for relative, fields in (
        ("windows-server/secrets.local.json", (("api_token",), ("model_api_key",))),
        ("windows-native/runtime/foxess-current-profile.private.json", (("llmConfig", "apiKey"), ("apiConfig", "token"))),
    ):
        private_path = ROOT / relative
        if not private_path.is_file():
            continue
        private = read_json(private_path)
        inspected += 1
        for field_path in fields:
            value = private
            for field in field_path:
                value = value.get(field) if isinstance(value, dict) else None
            if isinstance(value, str):
                values.append(value)
    if os.environ.get("LLM_WIKI_API_TOKEN"):
        values.append(os.environ["LLM_WIKI_API_TOKEN"])
    marker = public_model.get("credentialMarker")
    values = list(dict.fromkeys(value for value in values if len(value) >= 8 and value != marker))
    require(bool(values), "No usable local credential values were available for leak detection")
    patterns: set[bytes] = set()
    for value in values:
        # Cover normal UTF-8 text, UTF-16 PowerShell text and JSON escaping.
        for representation in (value, json.dumps(value, ensure_ascii=False)[1:-1], json.dumps(value, ensure_ascii=True)[1:-1]):
            patterns.add(representation.encode("utf-8"))
            patterns.add(representation.encode("utf-16-le"))
    return list(patterns), inspected


def contains_credential(data: bytes, needles: list[bytes]) -> bool:
    return any(needle in data for needle in needles)


def write_reports(report: dict) -> None:
    # These are build evidence, not application state. Never include captured logs.
    for destination in (RUNTIME / "installer-acceptance.json", RUNTIME / "offline-installer-acceptance.json", RELEASE / "安装包验证结果.json"):
        require(inside(destination, ROOT), "Report path escaped the checkout")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, destination)


def main() -> int:
    report = {
        "passed": False,
        "version": VERSION,
        "credentialMode": BUILD_INFO.get("credentialMode", "legacy-enterprise"),
        "testMode": "Offline EXTRACTONLY; synthetic provisioning and isolated NSIS _?= direct-mode uninstall only",
        "offline": True,
        "appStarted": False,
        "apiAccessed": False,
        "productionRestarted": False,
        "productionProfileReplaced": False,
        "existingInstallationTouched": False,
        "liveModelTested": False,
        "liveSharedDriveTested": False,
        "newCandidateLiveGuiEndToEndTested": False,
        "cleanMachineEndToEndTested": False,
        "limitations": [
            "Only extraction mode was exercised; normal installer registry, shortcuts and runtime installation were not exercised.",
            "First-run and existing-profile preservation were tested using synthetic local fixtures only.",
            "NSIS _?= direct uninstall may retain its locked Uninstall.exe; payload and installation metadata must still be removed.",
            "No real model, shared drive, GUI, API, CLI or MCP session was started or accessed.",
            "Existing application state and knowledge data were not opened or changed; private credential files were read only for leak detection.",
        ],
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    phase = "platform"
    try:
        require(os.name == "nt", "This verifier requires native Windows")
        phase = "build metadata"
        build = read_json(BUILD_PATH)
        installer = Path(build["installer"]).resolve()
        source_archive = Path(build["source"]).resolve()
        require(inside(RELEASE, ROOT / "windows-native/releases"), "Release directory escaped the checkout")
        if "version" in build:
            require(RELEASE.name == "v" + VERSION, "Versioned release directory mismatch")
        require(installer.parent == RELEASE.resolve(), "Installer is not in the expected release directory")
        require(source_archive.parent == RELEASE.resolve(), "Source archive is not in the expected release directory")
        require(installer.is_file() and source_archive.is_file() and CANDIDATE.is_file(), "A required build artifact is missing")
        require(digest(installer) == build.get("sha256"), "Installer hash differs from build metadata")
        candidate_hash = digest(CANDIDATE)
        report["installerSha256"] = build["sha256"]
        report["candidateExecutableSha256"] = candidate_hash

        phase = "isolated extraction"
        test_base = ROOT / ".installer-tests"
        require(inside(test_base, ROOT), "Test directory escaped the checkout")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        test = test_base / ("offline-release-" + stamp + "-" + uuid.uuid4().hex[:8])
        target = test / "安装校验 test"
        require(inside(target, test_base) and not test.exists(), "Unsafe or reused extraction directory")
        test.mkdir(parents=True, exist_ok=False)
        report["testDirectory"] = str(test)
        run_hidden(nsis_command(installer, "/S /EXTRACTONLY", "/D=" + str(target)), timeout=180)
        require((target / "extract-only.marker").is_file(), "Missing extraction-only marker")
        report["pathWithSpacesAndChinese"] = True

        phase = "payload hashes"
        manifest_path = target / "install-manifest.json"
        manifest = read_json(manifest_path)
        require(manifest.get("product") == "FoxEss WIKI" and manifest.get("version") == VERSION, "Unexpected installer product/version")
        rows = manifest.get("files")
        require(isinstance(rows, list) and bool(rows), "Empty or invalid installation manifest")
        seen: set[str] = set()
        payload_files: list[Path] = []
        for row in rows:
            require(isinstance(row, dict), "Invalid payload manifest row")
            path = payload_path(target, row.get("path"))
            key = str(path.relative_to(target)).replace("\\", "/").casefold()
            require(key not in seen, "Duplicate payload manifest path")
            seen.add(key)
            require(path.is_file() and not path.is_symlink(), "A manifest payload file is missing or linked")
            require(path.stat().st_size == row.get("size") and digest(path) == row.get("sha256"), "A payload size/hash differs from the manifest")
            payload_files.append(path)
        expected = {path.resolve() for path in payload_files} | {manifest_path.resolve(), (target / "Uninstall.exe").resolve(), (target / "extract-only.marker").resolve()}
        require({path.resolve() for path in target.rglob("*") if path.is_file()} == expected, "Unexpected or missing extracted files")
        require(digest(target / "app/llm-wiki.exe") == candidate_hash, "Packaged executable differs from the candidate")
        require(digest(target / "source" / source_archive.name) == digest(source_archive), "Packaged source archive differs from the release archive")
        report["verifiedPayloadFiles"] = len(payload_files)
        report["candidateExecutableMatched"] = True
        report["sourceArchiveMatched"] = True

        phase = "synthetic initialization"
        initialization_test = ROOT / "windows-native/installer/Test-Initialize.ps1"
        run_hidden(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(initialization_test),
                    "-ScriptsRoot", str(target / "scripts"), "-TestRoot", str(test / "synthetic-provisioning")], timeout=120)
        fixture = test / "synthetic-provisioning"
        state = read_json(fixture / "profile/app-state.json")
        default_state = read_json(fixture / "default-profile/app-state.json")
        require(state.get("lastProject", {}).get("name") == "Installer fixture", "Synthetic first-run state was not created")
        require(not (fixture / "other").exists(), "Rejected existing-profile initialization created another knowledge directory")
        built_in = bool(BUILD_INFO.get("nativeDefaultCredentialIncluded", True))
        if built_in:
            require(default_state.get("activePresetId") == "foxess-default" and default_state.get("llmConfig", {}).get("apiKey") == "__FOXESS_BUILTIN_CREDENTIAL__", "First-run enterprise default model was not selected")
        else:
            require(not default_state.get("activePresetId") and default_state.get("llmConfig", {}).get("apiKey") == "", "Public first-run model must have no built-in credential")
        require((fixture / "synthetic-source/manual.txt").read_text(encoding="utf-8-sig") == "SYNTHETIC_ONLY", "Synthetic source data changed")
        report.update({"managedFirstRunPassed": True, "existingProfilePreserved": True,
                       "existingProfilePreservedEvidence": "Test-Initialize.ps1 isolated fixture and hash assertion",
                       "firstRunCredentialModePassed": True, "syntheticSourceUnchanged": True})

        phase = "credential leak detection"
        public_model = read_json(target / "scripts/foxess-default-model.json")
        needles, private_inputs = credential_needles(public_model)
        text_count = 0
        for path in payload_files:
            if path.suffix.lower() in TEXT_SUFFIXES:
                require(not contains_credential(path.read_bytes(), needles), "A real credential was found in packaged text")
                text_count += 1
        source_count = 0
        with zipfile.ZipFile(source_archive) as archive:
            for entry in archive.infolist():
                if entry.is_dir() or PurePosixPath(entry.filename).suffix.lower() in SOURCE_BINARY_SUFFIXES:
                    continue
                require(not contains_credential(archive.read(entry), needles), "A real credential was found in corresponding source")
                source_count += 1
        report.update({"credentialScanPassed": True, "credentialScanPrivateFilesRead": private_inputs,
                       "credentialScanTextFiles": text_count, "credentialScanSourceEntries": source_count,
                       "nativeDefaultCredentialIncluded": bool(build.get("nativeDefaultCredentialIncluded")),
                       "credentialScanScope": "Extracted text payload and decompressed non-binary corresponding source; native binary credential is intentionally excluded"})
        del needles

        phase = "isolated uninstall"
        require(inside(target, test_base) and target.parent == test, "Unsafe uninstall target")
        require((target / "extract-only.marker").is_file() and manifest_path.is_file(), "Refusing uninstall without extraction-only evidence")
        uninstaller = target / "Uninstall.exe"
        require(uninstaller.is_file(), "Extracted uninstaller is missing")
        unknown = target / "user-project/keep.txt"
        unknown.parent.mkdir(exist_ok=False)
        unknown.write_text("USER_DATA_MUST_SURVIVE", encoding="utf-8")
        unknown_hash = digest(unknown)
        run_hidden(nsis_command(uninstaller, "/S", "_?=" + str(target)), timeout=120)
        require(unknown.is_file() and digest(unknown) == unknown_hash, "Uninstall removed or changed unknown user data")
        # _?= runs the uninstaller directly in this isolated target. Windows may
        # keep the running Uninstall.exe locked; it is generated at extraction
        # time and is not a manifest payload file. Do not mistake it for a
        # failure to clean the product payload or its installation metadata.
        managed = payload_files + [manifest_path, target / "extract-only.marker"]
        require(not any(path.exists() for path in managed), "Packaged payload or installation metadata remained after uninstall")
        remaining = {path.resolve() for path in target.rglob("*") if path.is_file()}
        allowed_remaining = {unknown.resolve(), uninstaller.resolve()}
        require(unknown.resolve() in remaining and remaining <= allowed_remaining, "Unexpected files remained in the isolated install directory")
        report.update({"uninstallPreservesUnknownUserData": True, "programPayloadRemoved": True,
                       "metadataRemoved": True, "directUninstallMode": "NSIS _?= (no temporary self-copy)",
                       "directUninstallExecutableRetained": uninstaller.is_file(), "passed": True})
        phase = "complete"
    except Exception as error:
        # Subprocess stderr or JSON decode errors could contain sensitive values;
        # keep only a fixed check label and exception type in public evidence.
        report["failedPhase"] = phase
        report["failureType"] = type(error).__name__
        if isinstance(error, VerificationFailure):
            report["failureReason"] = str(error)
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    try:
        write_reports(report)
    except Exception as error:
        print(json.dumps({"passed": False, "failedPhase": "write reports", "failureType": type(error).__name__}))
        return 1
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
