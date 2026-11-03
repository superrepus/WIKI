import test from "node:test"
import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, verify } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { signRelease, verifySignedRelease } from "./Sign-Release.mjs"

const sha = value => createHash("sha256").update(value).digest("hex")
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foxess-release-sign-"))
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith("foxess-release-sign-"))
    await fs.rm(root, { recursive: true, force: true })
  })
  const runtime = path.join(root, "windows-native/runtime")
  const release = path.join(root, "windows-native/releases/v1.0.0")
  const resources = path.join(root, "src-tauri/resources")
  for (const directory of [runtime, release, resources]) await fs.mkdir(directory, { recursive: true })
  const pair = generateKeyPairSync("ed25519")
  const privatePath = path.join(runtime, "update-signing-key.private.pem")
  await fs.writeFile(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }))
  await fs.writeFile(path.join(resources, "update-public-key.json"), JSON.stringify({ algorithm: "ed25519", publicKey: Buffer.from(pair.publicKey.export({ format: "jwk" }).x, "base64url").toString("base64") }))
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }))
  const bytes = Buffer.from("SYNTHETIC_INSTALLER_ONLY")
  const installer = path.join(release, "FoxEss-WIKI-1.0.0-x64-Setup.exe")
  const executable = path.join(runtime, "candidate.exe")
  await fs.writeFile(installer, bytes)
  await fs.writeFile(executable, "SYNTHETIC_EXECUTABLE_ONLY")
  const executableSha256 = sha("SYNTHETIC_EXECUTABLE_ONLY")
  const manifest = { schema: 1, repo: "superrepus/WIKI", version: "1.0.0", installer: { name: path.basename(installer), sha256: sha(bytes), size: bytes.length }, executableSha256 }
  const manifestPath = path.join(release, "FoxEss-WIKI-1.0.0-update.json")
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  await fs.writeFile(path.join(runtime, "installer-build.json"), JSON.stringify({ version: "1.0.0", installer, executable, sha256: sha(bytes) }))
  await fs.writeFile(path.join(runtime, "external-release-acceptance.json"), JSON.stringify({ passed: true, version: "1.0.0", executableSha256 }))
  return { root, runtime, release, privatePath, manifestPath, installer, executable, pair, manifest }
}

test("signs the exact verified manifest bytes and checksums public assets", async t => {
  const f = await fixture(t)
  const report = await signRelease({ root: f.root })
  const bytes = await fs.readFile(f.manifestPath)
  const signature = Buffer.from((await fs.readFile(report.signature, "utf8")).trim(), "base64")
  assert.equal(verify(null, bytes, f.pair.publicKey, signature), true)
  assert.equal(verify(null, Buffer.concat([bytes, Buffer.from(" ")]), f.pair.publicKey, signature), false)
  const sums = await fs.readFile(path.join(f.release, "SHA256SUMS.txt"), "utf8")
  assert.match(sums, /FoxEss-WIKI-1\.0\.0-update\.json\.sig/)
  assert.doesNotMatch(sums, /private|SHA256SUMS/)
})

test("rejects a signing key that does not match the embedded verification key", async t => {
  const f = await fixture(t)
  const wrong = path.join(f.runtime, "wrong.private.pem")
  await fs.writeFile(wrong, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }))
  await assert.rejects(signRelease({ root: f.root, keyPath: wrong }), /does not match/)
})

test("rejects a changed installer instead of blessing it with a signature", async t => {
  const f = await fixture(t)
  await fs.appendFile(f.installer, "CHANGED")
  await assert.rejects(signRelease({ root: f.root }), /differs from the verified manifest/)
})

test("rejects a changed executable after build acceptance", async t => {
  const f = await fixture(t)
  await fs.appendFile(f.executable, "CHANGED")
  await assert.rejects(signRelease({ root: f.root }), /changed after acceptance/)
})

test("rejects a manifest for a different repository or version", async t => {
  const f = await fixture(t)
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, repo: "somebody/other" }))
  await assert.rejects(signRelease({ root: f.root }), /identity does not match/)
})

test("refuses to use or checksum a private signing key in release assets", async t => {
  const f = await fixture(t)
  const unsafe = path.join(f.release, "secret.private.pem")
  await fs.copyFile(f.privatePath, unsafe)
  await assert.rejects(signRelease({ root: f.root, keyPath: unsafe }), /must be outside/)
  await assert.rejects(signRelease({ root: f.root }), /must not be included/)
})

test("public verification needs no private key, candidate executable or build metadata", async t => {
  const f = await fixture(t)
  await signRelease({ root: f.root })
  for (const file of [f.privatePath, f.executable, path.join(f.runtime, "installer-build.json"), path.join(f.runtime, "external-release-acceptance.json")]) await fs.unlink(file)
  assert.equal((await verifySignedRelease({ root: f.root })).verified, true)
  await fs.appendFile(f.manifestPath, " ")
  await assert.rejects(verifySignedRelease({ root: f.root }), /signature verification failed/)
})
