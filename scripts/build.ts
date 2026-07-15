import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { managedWidgetInlineStyleText } from '../src/widget'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })

const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'browser' as const,
  target: ['es2020'],
  sourcemap: true,
  legalComments: 'external' as const,
}

const [, standaloneBuild] = await Promise.all([
  build({
    ...shared,
    format: 'esm',
    outfile: 'dist/index.js',
    // Keep the optional voice transport as a runtime dependency for module
    // consumers. The standalone IIFE below remains self-contained.
    external: ['@elevenlabs/client'],
  }),
  build({
    ...shared,
    format: 'iife',
    globalName: 'ConvincedWidgetSDK',
    outfile: 'dist/convinced-widget.global.js',
    minify: true,
    metafile: true,
  }),
])

await writeThirdPartyNotices(Object.keys(standaloneBuild.metafile.inputs))

const managedWidgetStyleHash = createHash('sha256')
  .update(managedWidgetInlineStyleText())
  .digest('base64')
await writeFile(
  new URL('../dist/managed-widget-style.sha256', import.meta.url),
  `sha256-${managedWidgetStyleHash}\n`,
)

interface PackageMetadata {
  name?: string
  version?: string
  license?: string | { type?: string }
  homepage?: string
  repository?: string | { url?: string }
}

interface Notice {
  key: string
  name: string
  version: string
  license: string
  source: string
  texts: string[]
}

async function writeThirdPartyNotices(inputs: string[]): Promise<void> {
  const packageRoots = new Set<string>()
  for (const input of inputs) {
    const packageRoot = packageRootForInput(input)
    if (packageRoot) packageRoots.add(packageRoot)
  }

  const notices = (await Promise.all([...packageRoots].map(readNotice)))
    .filter((notice): notice is Notice => notice !== null)
    .sort((left, right) => left.key.localeCompare(right.key))

  const body = notices.map((notice) => {
    const header = [
      notice.key,
      `License: ${notice.license}`,
      ...(notice.source ? [`Source: ${notice.source}`] : []),
    ].join('\n')
    const licenseText = notice.texts.length > 0
      ? notice.texts.join('\n\n')
      : `No license file was found in the installed package. Declared license: ${notice.license}.`
    return `${header}\n\n${licenseText}`
  }).join('\n\n================================================================================\n\n')

  const preamble = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'The standalone Convinced browser bundle includes the following third-party packages.',
    'These notices apply only to those third-party components; Convinced code is licensed',
    'under the repository LICENSE file.',
    '',
  ].join('\n')
  await writeFile(new URL('../dist/THIRD_PARTY_NOTICES.txt', import.meta.url), `${preamble}${body}\n`)
}

function packageRootForInput(input: string): string | null {
  const normalized = input.replaceAll('\\', '/')
  const marker = 'node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0) return null

  const dependencyPath = normalized.slice(markerIndex + marker.length)
  const segments = dependencyPath.split('/')
  const packageSegments = segments[0]?.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)
  if (packageSegments.length === 0 || packageSegments.some((segment) => !segment)) return null

  const parent = normalized.slice(0, markerIndex + marker.length)
  return resolve(root, parent, ...packageSegments)
}

async function readNotice(packageRoot: string): Promise<Notice | null> {
  let metadata: PackageMetadata
  try {
    metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as PackageMetadata
  } catch {
    return null
  }

  const name = metadata.name?.trim()
  const version = metadata.version?.trim()
  if (!name || !version) return null

  const entries = await readdir(packageRoot, { withFileTypes: true })
  const licenseFiles = entries
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const texts = await Promise.all(licenseFiles.map(async (filename) => {
    const text = (await readFile(resolve(packageRoot, filename), 'utf8')).trim()
    return `${filename}\n${'-'.repeat(filename.length)}\n${text}`
  }))

  const repository = typeof metadata.repository === 'string'
    ? metadata.repository
    : metadata.repository?.url
  const declaredLicense = typeof metadata.license === 'string'
    ? metadata.license
    : metadata.license?.type

  return {
    key: `${name}@${version}`,
    name,
    version,
    license: declaredLicense?.trim() || 'SEE INCLUDED LICENSE TEXT',
    source: metadata.homepage?.trim() || repository?.trim() || '',
    texts,
  }
}
