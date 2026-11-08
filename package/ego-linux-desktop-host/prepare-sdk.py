#!/usr/bin/env python3
"""Prepare a verified, pinned SDK for the opt-in reference host."""
import hashlib
from pathlib import Path
import stat
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
SDK_URL = 'https://github.com/citrolabs/ego-lite/releases/download/v2.2.0/ego-browser-v2.2.0.zip'
SDK_SHA256 = 'a81348305c4edc3f9cdda8c4408b98b7ce740365b8f4efc9931dd0e7f5555eba'


def main():
    target = ROOT / 'sdk'
    if target.exists() or target.is_symlink():
        raise RuntimeError('SDK directory already exists; use a fresh checkout')
    # Validate and adapt in a private temporary stage before making it visible.
    with tempfile.TemporaryDirectory(prefix='.sdk-', dir=ROOT) as temporary:
        stage = Path(temporary)
        archive = stage / 'sdk.zip'
        with urllib.request.urlopen(SDK_URL, timeout=60) as response, archive.open('xb') as output:
            digest = hashlib.sha256()
            total = 0
            while chunk := response.read(65536):
                total += len(chunk)
                if total > 32 * 1024 * 1024:
                    raise RuntimeError('SDK archive exceeds the size limit')
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != SDK_SHA256:
            raise RuntimeError('SDK SHA-256 mismatch')
        extracted = stage / 'payload'
        extracted.mkdir()
        total = 0
        with zipfile.ZipFile(archive) as package:
            for item in package.infolist():
                entry = Path(item.filename)
                total += item.file_size
                if entry.is_absolute() or '..' in entry.parts or stat.S_ISLNK(item.external_attr >> 16) or total > 64 * 1024 * 1024:
                    raise RuntimeError('Unsafe SDK archive entry')
                destination = extracted / entry
                if item.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with destination.open('xb') as output:
                        output.write(package.read(item))
        bundle = extracted / 'index.js'
        text = bundle.read_text()
        # Keep the experimental host independent of native-app releases. The
        # original SDK bytes are pinned above; only these two hooks are adapted.
        clipboard = 'function beginNativeClipboardTransaction(input, platform = process.platform) {'
        identity = 'return `browser-host:${parentPid}`;'
        if text.count(clipboard) != 1 or text.count(identity) != 1:
            raise RuntimeError('Pinned SDK adaptation anchor changed')
        text = text.replace(clipboard, clipboard + '\n    if (platform === "linux" && typeof globalThis.ego?.beginClipboardTransaction === "function") return globalThis.ego.beginClipboardTransaction(input);', 1)
        text = text.replace(identity, 'return typeof globalThis.ego?.browserInstanceId === "string" ? globalThis.ego.browserInstanceId : `browser-host:${parentPid}`;', 1)
        bundle.write_text(text)
        (extracted / 'LICENSE').write_bytes((ROOT.parents[1] / 'LICENSE').read_bytes())
        (extracted / 'SOURCE.txt').write_text('SDK v2.2.0\nOriginal SHA-256: ' + SDK_SHA256 + '\nAdaptations: Linux clipboard transaction; host instance identity\nAdapted bundle SHA-256: ' + hashlib.sha256(bundle.read_bytes()).hexdigest() + '\n')
        extracted.rename(target)
    print('Prepared verified SDK v2.2.0; only the two documented host adapters were applied')


if __name__ == '__main__':
    main()
