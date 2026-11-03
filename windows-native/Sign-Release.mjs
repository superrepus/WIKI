/** Sign a verified release manifest. The signing key is a local build input only. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
function requireValue(value, label) { if (!value) throw new Error(label) }
const json = async file => JSON.parse(await fs.readFile(file, "utf8"))
async function digest(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

/** Verify public release assets only. This path never opens the private key or build cache. */
export async function verifySignedRelease({ root = checkout } = {}) {
  root = path.resolve(root)
  const version = (await json(path.join(root, "package.json"))).version
  requireValue(stableVersion.test(version), "Package version must be a stable semantic version")
  const release = path.join(root, "windows-native", "releases", `v${version}`)
  const manifestPath = path.join(release, `FoxEss-WIKI-${version}-update.json`)
  const raw = await fs.readFile(manifestPath)
  const manifest = JSON.parse(raw.toString("utf8"))
  const filename = `FoxEss-WIKI-${version}-x64-Setup.exe`
  requireValue(manifest.schema === 1 && manifest.repo === "superrepus/WIKI" && manifest.version === version && manifest.installer?.name === filename, "Manifest identity does not match this release")
  const publicConfig = await json(path.join(root, "src-tauri", "resources", "update-public-key.json"))
  const expectedPublic = Buffer.from(publicConfig.publicKey, "base64")
  requireValue(publicConfig.algorithm === "ed25519" && expectedPublic.length === 32, "Invalid release verification public key")
  const publicKey = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: expectedPublic.toString("base64url") } })
  const signatureText = (await fs.readFile(`${manifestPath}.sig`, "utf8")).trim()
  requireValue(/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText), "Invalid release signature encoding")
  const signature = Buffer.from(signatureText, "base64")
  requireValue(signature.length === 64 && verify(null, raw, publicKey, signature), "Release signature verification failed")
  const installer = path.join(release, filename)
  requireValue(await digest(installer) === manifest.installer.sha256 && (await fs.stat(installer)).size === manifest.installer.size, "Installer differs from the signed manifest")
  return { version, manifest: manifestPath, signature: `${manifestPath}.sig`, installerSha256: manifest.installer.sha256, verified: true }
}

export async function signRelease({ root = checkout, keyPath = process.env.FOXESS_UPDATE_SIGNING_KEY } = {}) {
  root = path.resolve(root)
  const version = (await json(path.join(root, "package.json"))).version
  requireValue(stableVersion.test(version), "Package version must be a stable semantic version")
  const release = path.join(root, "windows-native", "releases", `v${version}`)
  const runtime = path.join(root, "windows-native", "runtime")
  const manifestPath = path.join(release, `FoxEss-WIKI-${version}-update.json`)
  const raw = await fs.readFile(manifestPath)
  const manifest = JSON.parse(raw.toString("utf8"))
  const build = await json(path.join(runtime, "installer-build.json"))
  const accepted = await json(path.join(runtime, "external-release-acceptance.json"))
  const filename = `FoxEss-WIKI-${version}-x64-Setup.exe`
  const installer = path.join(release, filename)
  requireValue(manifest.schema === 1 && manifest.repo === "superrepus/WIKI" && manifest.version === version, "Manifest identity does not match this release")
  requireValue(manifest.installer?.name === filename, "Unexpected installer asset name")
  requireValue(path.resolve(build.installer) === installer && build.version === version, "Build metadata does not match this release")
  const installerHash = await digest(installer)
  requireValue(installerHash === manifest.installer.sha256 && installerHash === build.sha256 && (await fs.stat(installer)).size === manifest.installer.size, "Installer differs from the verified manifest")
  requireValue(accepted.passed && accepted.version === version && accepted.executableSha256 === manifest.executableSha256, "Executable acceptance does not match this release")
  requireValue(await digest(build.executable) === manifest.executableSha256, "Candidate executable changed after acceptance")

  const privatePath = path.resolve(keyPath || path.join(runtime, "update-signing-key.private.pem"))
  const keyRelative = path.relative(release, privatePath)
  requireValue(keyRelative.startsWith("..") || path.isAbsolute(keyRelative), "Signing private key must be outside the release directory")
  const publicConfig = await json(path.join(root, "src-tauri", "resources", "update-public-key.json"))
  requireValue(publicConfig.algorithm === "ed25519", "Unsupported update signature algorithm")
  const expectedPublic = Buffer.from(publicConfig.publicKey, "base64")
  requireValue(expectedPublic.length === 32, "Invalid release verification public key")
  const privateKey = createPrivateKey(await fs.readFile(privatePath))
  requireValue(privateKey.asymmetricKeyType === "ed25519", "Release signing key must use Ed25519")
  const publicKey = createPublicKey(privateKey)
  const actualPublic = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")
  requireValue(expectedPublic.equals(actualPublic), "Signing key does not match the application verification key")
  const signature = sign(null, raw, privateKey)
  requireValue(signature.length === 64 && verify(null, raw, publicKey, signature), "Release signature verification failed")
  const signaturePath = `${manifestPath}.sig`
  await fs.writeFile(signaturePath, signature.toString("base64") + "\n", "utf8")

  const files = (await fs.readdir(release, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name !== "SHA256SUMS.txt").map(entry => entry.name).sort()
  requireValue(!files.some(name => /\.private\.|\.(pem|key)$/i.test(name)), "Private key material must not be included in release assets")
  const sums = []
  for (const name of files) sums.push(`${await digest(path.join(release, name))}  ${name}`)
  await fs.writeFile(path.join(release, "SHA256SUMS.txt"), sums.join("\n") + "\n", "utf8")
  return { version, manifest: manifestPath, signature: signaturePath, installerSha256: installerHash, checksummedFiles: files.length }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2)
    requireValue(args.length === 0 || args.length === 1 && args[0] === "--verify-only", "Unknown release signing option")
    console.log(JSON.stringify(args[0] === "--verify-only" ? await verifySignedRelease() : await signRelease()))
  }
  catch { console.error("Release signing failed. Check the verified artifacts, release identity and local signing-key configuration."); process.exitCode = 1 }
}
