import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'convinced-widget-sdk-package-'))

try {
  const packOutput = await run([
    'npm',
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    temporaryRoot,
  ], root)
  const packed = parsePackOutput(packOutput)
  const packedPaths = new Set(packed.files.map((file) => file.path))

  for (const required of [
    'AGENT_BUILD_PROMPT.txt',
    'LICENSE',
    'README.md',
    'dist/THIRD_PARTY_NOTICES.txt',
    'dist/convinced-widget.global.js',
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]) {
    if (!packedPaths.has(required)) throw new Error(`Packed package is missing ${required}.`)
  }

  for (const path of packedPaths) {
    if (
      path.startsWith('src/') ||
      path.startsWith('tests/') ||
      path.startsWith('examples/real-org-lab/') ||
      path.includes('/.env') ||
      path === '.env'
    ) {
      throw new Error(`Private or development-only file was packed: ${path}`)
    }
  }

  if (packed.size > 1_500_000) {
    throw new Error(`Packed tarball is ${packed.size} bytes; the release budget is 1,500,000 bytes.`)
  }
  if (packed.unpackedSize > 5_000_000) {
    throw new Error(`Unpacked package is ${packed.unpackedSize} bytes; the release budget is 5,000,000 bytes.`)
  }

  const consumer = join(temporaryRoot, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'convinced-widget-sdk-package-consumer',
    private: true,
    type: 'module',
  }, null, 2)}\n`)

  const tarball = join(temporaryRoot, packed.filename)
  await run([
    'npm',
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ], consumer)

  await writeFile(join(consumer, 'consumer.ts'), `
import {
  ConvincedClient,
  type WidgetConfig,
} from '@convinced/widget-sdk'

const config: WidgetConfig = { orgName: 'Example', orgSlug: 'example' }
const client = new ConvincedClient({ orgSlug: config.orgSlug })
void client.state
`)

  for (const [name, compilerOptions] of Object.entries({
    bundler: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
    nodenext: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    },
  })) {
    const tsconfigPath = join(consumer, `tsconfig.${name}.json`)
    await writeFile(tsconfigPath, `${JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        noEmit: true,
        strict: true,
        skipLibCheck: false,
      },
      files: ['./consumer.ts'],
    }, null, 2)}\n`)
    await run([join(root, 'node_modules', '.bin', 'tsc'), '-p', tsconfigPath], consumer)
  }

  const runtimeCheck = [
    "import('@convinced/widget-sdk')",
    ".then((sdk) => {",
    "  if (typeof sdk.ConvincedClient !== 'function') throw new Error('Missing ConvincedClient export')",
    '})',
  ].join('')
  await run(['node', '--input-type=module', '--eval', runtimeCheck], consumer)
  await run(['bun', '--eval', runtimeCheck], consumer)
  await run(['npm', 'audit', '--omit=dev', '--audit-level=high'], consumer)

  const packageJson = JSON.parse(await readFile(join(consumer, 'node_modules/@convinced/widget-sdk/package.json'), 'utf8')) as {
    name?: string
    version?: string
  }
  console.log(
    `Packed consumer passed: ${packageJson.name}@${packageJson.version}, ` +
    `${packed.files.length} files, ${packed.size} bytes.`,
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

interface PackResult {
  filename: string
  size: number
  unpackedSize: number
  files: Array<{ path: string }>
}

function parsePackOutput(output: string): PackResult {
  const parsed = JSON.parse(output) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm pack returned an unexpected result.')
  }
  const candidate = parsed[0] as Partial<PackResult>
  if (
    typeof candidate.filename !== 'string' ||
    typeof candidate.size !== 'number' ||
    typeof candidate.unpackedSize !== 'number' ||
    !Array.isArray(candidate.files)
  ) {
    throw new Error('npm pack omitted required package metadata.')
  }
  return candidate as PackResult
}

async function run(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: processEnv(),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed (${exitCode}).\n${stdout}\n${stderr}`)
  }
  return stdout.trim()
}

function processEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(Bun.env)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}
