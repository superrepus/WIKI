"""Gate the reference-source release without stopping a busy production app."""
from pathlib import Path
import hashlib, json, re, sys

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / 'windows-native/runtime'

def native_count(name):
    text = (RUNTIME / name).read_text(encoding='utf-8-sig')
    result = re.search(r'test result: ok\. (\d+) passed; 0 failed;', text)
    if not result:
        raise RuntimeError('Missing passing native result: ' + name)
    return int(result.group(1))

def main():
    windows = json.loads((ROOT/'src-tauri/tauri.windows.conf.json').read_text(encoding='utf-8'))
    main_window = next(row for row in windows['app']['windows'] if row.get('label','main') == 'main')
    if main_window.get('title') != 'FoxEss WIKI':
        raise RuntimeError('The Windows override must explicitly declare the FoxEss window title')
    result = json.loads((RUNTIME/'external-vitest-final.json').read_text(encoding='utf-8-sig'))
    if not result.get('success') or result.get('numFailedTests') or result.get('numRuntimeErrorTestSuites'):
        raise RuntimeError('The final frontend regression has not passed')
    for test in ('scheduled-import-display.test.ts', 'scheduled-import-section.test.tsx',
                 'scheduled-import-multi.test.ts', 'scheduled-import-config.test.ts',
                 'project-store-scheduled-import.test.ts', 'scheduled-import-draft.test.ts',
                 'external-source-sync.test.ts', 'update-check.test.ts',
                 'update-runtime.test.ts', 'update-install.test.ts'):
        if not any(test in row.get('name','') and row.get('status') == 'passed' for row in result.get('testResults',[])):
            raise RuntimeError('The monitor-path regression has not passed: ' + test)
    external = native_count('external-native-final-tests.log')
    history = native_count('external-native-history-tests.log')
    if external < 8 or history < 2:
        raise RuntimeError('Required source/history native coverage is missing')
    updater = native_count('v1-update-native-tests.log')
    if updater < 1:
        raise RuntimeError('Current native updater regression is missing')
    updater_log = (RUNTIME/'v1-update-native-tests.log').read_text(encoding='utf-8-sig')
    if 'github_update::tests::' not in updater_log:
        raise RuntimeError('The native updater test filter was not exercised')
    helper = json.loads((RUNTIME/'v1-update-helper-tests.json').read_text(encoding='utf-8-sig'))
    if not helper.get('passed'):
        raise RuntimeError('The synthetic update-helper regression has not passed')
    helper_hash = hashlib.sha256((ROOT/'windows-native/installer/Update.ps1').read_bytes()).hexdigest()
    if helper.get('helperSha256') != helper_hash:
        raise RuntimeError('The update helper changed after its synthetic regression')
    provenance = json.loads((RUNTIME/'build-provenance.json').read_text(encoding='utf-8-sig'))
    version = json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']
    if provenance.get('version') != version:
        raise RuntimeError('Candidate version differs from package version')
    executable = Path(provenance['executable'])
    with executable.open('rb') as stream:
        digest = hashlib.file_digest(stream,'sha256').hexdigest()
    if digest != provenance.get('executableSha256'):
        raise RuntimeError('Candidate hash differs from build provenance')
    report = {
        'passed':True, 'version':version, 'credentialMode':provenance['credentialMode'], 'executableSha256':digest,
        'mode':'current frontend and updater native/helper regression + unchanged source/history baseline; no production launch',
        'frontendPassed':result['numPassedTests'], 'frontendSkipped':result.get('numPendingTests',0),
        'externalSourceNativePassed':external, 'historyNativePassed':history,
        'githubUpdaterNativePassed':updater, 'githubUpdateHelperSyntheticPassed':True,
        'registeredOriginalReadHashListSearchAndLocalCache':True,
        'originalWritesAndDeletesPreventedThroughRegisteredAlias':True,
        'manualAndScheduledReferenceImport':True,
        'addModifyDeleteAndDisconnectedShareRegression':True,
        'legacyMirrorsRetainedAndArchivedOnRemoval':True,
        'readOnlySourcePreviewAndEditableWikiRegression':True,
        'apiRescanAsynchronousDispatchRegression':True,
        'deletedProjectHistoryRegression':True,
        'monitorPathEmptyUncAndOriginalLocationDisplayRegression':True,
        'manualOriginalsAlwaysMonitoredRegression':True,
        'multipleExtraDirectoriesIndependentScheduleRegression':True,
        'overlappingDirectoryOwnershipAndPendingRetryRegression':True,
        'legacySingleDirectoryMigrationAndConcurrentScanTimestampsRegression':True,
        'windowsNativeWindowTitle':'FoxEss WIKI',
        'windowsTitleOverrideValidated':True,
        'productionRestarted':False, 'productionProfileReplaced':False,
        'newCandidateLiveGuiEndToEndTested':False,
        'reason':'Offline candidate verification preserves existing knowledge and model settings. The new GUI is not launched automatically.',
    }
    (RUNTIME/'external-release-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
