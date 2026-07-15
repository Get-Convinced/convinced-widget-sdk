import {
  HOST_TOOL_PROTOCOL_VERSION,
  MAX_HOST_TOOLS,
  MAX_HOST_TOOL_MANIFEST_BYTES,
  MAX_HOST_TOOL_ARGS_BYTES,
  MAX_HOST_TOOL_RESULT_BYTES,
  MAX_HOST_TOOL_SCHEMA_BYTES,
  MAX_HOST_TOOL_SCHEMA_DEPTH,
  MAX_HOST_TOOL_TIMEOUT_MS,
  type ClientTool,
  type ClientToolCall,
  type ClientToolDefinition,
  type ClientToolExecutionContext,
  type ClientToolResult,
  type ExecuteClientToolOptions,
  type JsonObject,
  type JsonValue,
} from '../types.js'

const TOOL_NAME = /^(?:host|client)_[a-z0-9_]+$/
const SCHEMA_PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
const SUPPORTED_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'title',
  'description',
  'default',
  'examples',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'anyOf',
  'oneOf',
  'allOf',
])
export class ClientToolRegistry {
  private readonly tools = new Map<string, ClientTool>()

  constructor(tools: ClientTool[] = []) {
    this.registerMany(tools)
  }

  register(tool: ClientTool): () => void {
    validateTool(tool)
    if (this.tools.size >= MAX_HOST_TOOLS) {
      throw new Error(`A client may register at most ${MAX_HOST_TOOLS} host tools.`)
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Client tool "${tool.name}" is already registered.`)
    }
    const prospectiveDefinitions = [
      ...this.tools.values(),
      tool,
    ].map(toDefinition)
    const manifestBytes = jsonByteLength(prospectiveDefinitions)
    if (manifestBytes === null || manifestBytes > MAX_HOST_TOOL_MANIFEST_BYTES) {
      throw new Error(
        `Client tool manifest exceeds ${MAX_HOST_TOOL_MANIFEST_BYTES} bytes.`,
      )
    }
    this.tools.set(tool.name, tool)
    return () => this.unregister(tool.name)
  }

  registerMany(tools: ClientTool[]): void {
    for (const tool of tools) this.register(tool)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  clear(): void {
    this.tools.clear()
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): ClientTool | undefined {
    return this.tools.get(name)
  }

  definitions(): ClientToolDefinition[] {
    return [...this.tools.values()].map(toDefinition)
  }

  /**
   * Execute a registered tool by name from a non-SSE adapter (for example,
   * ElevenLabs voice). This constructs canonical call metadata, validates the
   * argument object against the registered schema, enforces all bounds, and
   * denies consented tools unless the caller explicitly authorizes the call.
   */
  async executeByName(
    name: string,
    arguments_: JsonObject | string,
    context: ClientToolExecutionContext,
    options: ExecuteClientToolOptions = {},
  ): Promise<ClientToolResult> {
    const tool = this.tools.get(name)
    const callId = options.callId ?? executionId()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
      throw new Error('Client tool callId is invalid.')
    }
    let args: JsonObject
    try {
      args = parseToolArguments(arguments_)
    } catch (error) {
      return immediateError({
        version: HOST_TOOL_PROTOCOL_VERSION,
        id: callId,
        name,
        args: {},
        locality: 'host',
        effect: tool?.effect ?? 'mutate',
        consent: tool?.consent ?? 'per_call',
      }, 'invalid_tool_arguments', errorMessage(error).slice(0, 1_000))
    }
    const call: ClientToolCall = {
      version: HOST_TOOL_PROTOCOL_VERSION,
      id: callId,
      name,
      args,
      locality: 'host',
      effect: tool?.effect ?? 'mutate',
      consent: tool?.consent ?? 'per_call',
    }

    if (tool) {
      const argsError = validateToolArguments(tool, call.args)
      if (argsError) return immediateError(call, argsError.code, argsError.message)
    }

    if (tool && tool.consent !== 'none') {
      if (!options.authorize) {
        return immediateError(call, 'consent_denied', `Client tool "${name}" requires host authorization.`)
      }
      try {
        const allowed = await options.authorize({
          call,
          tool: toDefinition(tool),
          execution: context,
        })
        if (!allowed) {
          return immediateError(call, 'consent_denied', `Host application denied client tool "${name}".`)
        }
      } catch (error) {
        return immediateError(
          call,
          context.signal.aborted ? 'turn_cancelled' : 'authorization_error',
          errorMessage(error).slice(0, 1_000),
        )
      }
    }

    return this.execute(call, context)
  }

  async execute(
    call: ClientToolCall,
    context: ClientToolExecutionContext,
  ): Promise<ClientToolResult> {
    const startedAt = monotonicNow()
    const finish = (
      result: Omit<ClientToolResult, 'version' | 'callId' | 'name' | 'args' | 'durationMs'>,
    ): ClientToolResult => ({
      version: HOST_TOOL_PROTOCOL_VERSION,
      callId: call.id,
      name: call.name,
      args: call.args,
      ...result,
      durationMs: Math.min(MAX_HOST_TOOL_TIMEOUT_MS, Math.max(0, monotonicNow() - startedAt)),
    })

    const tool = this.tools.get(call.name)
    if (!tool) {
      return finish({
        ok: false,
        error: {
          code: 'tool_not_registered',
          message: `Client tool "${call.name}" is not registered.`,
        },
      })
    }
    if (
      call.version !== HOST_TOOL_PROTOCOL_VERSION ||
      call.locality !== 'host' ||
      call.effect !== tool.effect ||
      call.consent !== tool.consent
    ) {
      return finish({
        ok: false,
        error: {
          code: 'tool_contract_mismatch',
          message: `Client tool call metadata for "${call.name}" does not match its registered manifest.`,
        },
      })
    }


    const argsError = validateToolArguments(tool, call.args)
    if (argsError) {
      return finish({
        ok: false,
        error: argsError,
      })
    }

    const timeoutController = new AbortController()
    const abortFromTurn = () => timeoutController.abort(context.signal.reason)
    context.signal.addEventListener('abort', abortFromTurn, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timeoutController.abort(new Error('Client tool timed out.'))
          reject(new ToolTimeoutError(tool.timeoutMs))
        }, tool.timeoutMs)
      })
      const value = await Promise.race([
        tool.handler(call.args, { ...context, signal: timeoutController.signal }),
        timeoutPromise,
      ])
      const result = value === undefined ? null : toJsonValue(value)
      const resultDepth = jsonDepth(result)
      if (resultDepth === null || resultDepth > MAX_HOST_TOOL_SCHEMA_DEPTH) {
        return finish({
          ok: false,
          error: {
            code: 'result_too_deep',
            message: `Client tool result exceeds maximum depth ${MAX_HOST_TOOL_SCHEMA_DEPTH}.`,
          },
        })
      }
      if (jsonBytes(result) > MAX_HOST_TOOL_RESULT_BYTES) {
        return finish({
          ok: false,
          error: {
            code: 'result_too_large',
            message: `Client tool result exceeds ${MAX_HOST_TOOL_RESULT_BYTES} bytes.`,
          },
        })
      }
      return finish({ ok: true, result })
    } catch (error) {
      return finish({
        ok: false,
        error: {
          code:
            error instanceof ToolTimeoutError
              ? 'tool_timeout'
              : context.signal.aborted
                ? 'turn_cancelled'
                : 'tool_execution_error',
          message: errorMessage(error).slice(0, 1_000),
        },
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      context.signal.removeEventListener('abort', abortFromTurn)
    }
  }
}

/** Backwards-compatible argument parser for pre-v1 event payloads. */
export function parseToolArguments(value: JsonObject | string): JsonObject {
  if (typeof value !== 'string') return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Tool arguments must decode to a JSON object.')
    }
    return parsed as JsonObject
  } catch (error) {
    throw new Error(`Invalid client tool arguments: ${errorMessage(error)}`)
  }
}

function validateToolArguments(
  tool: ClientTool,
  args: JsonObject,
): { code: string; message: string } | null {
  if (!isPlainObject(args)) {
    return { code: 'invalid_tool_arguments', message: 'Client tool arguments must be a JSON object.' }
  }
  const bytes = jsonByteLength(args)
  if (bytes === null) {
    return { code: 'invalid_tool_arguments', message: 'Client tool arguments must be JSON-serializable.' }
  }
  if (bytes > MAX_HOST_TOOL_ARGS_BYTES) {
    return {
      code: 'arguments_too_large',
      message: `Client tool arguments exceed ${MAX_HOST_TOOL_ARGS_BYTES} bytes.`,
    }
  }
  const depth = jsonDepth(args)
  if (depth === null) {
    return { code: 'invalid_tool_arguments', message: 'Client tool arguments contain invalid JSON values.' }
  }
  if (depth > MAX_HOST_TOOL_SCHEMA_DEPTH) {
    return {
      code: 'arguments_too_deep',
      message: `Client tool arguments exceed maximum depth ${MAX_HOST_TOOL_SCHEMA_DEPTH}.`,
    }
  }
  const schemaError = validateSchemaValue(tool.inputSchema, args, '$')
  return schemaError
    ? { code: 'invalid_tool_arguments', message: schemaError.slice(0, 1_000) }
    : null
}

function validateSchemaValue(schema: JsonObject, value: unknown, path: string): string | null {
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : null
  if (anyOf && !anyOf.some((branch) => isPlainObject(branch) && !validateSchemaValue(branch, value, path))) {
    return `${path} does not match any allowed schema.`
  }
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (oneOf) {
    const matches = oneOf.filter(
      (branch) => isPlainObject(branch) && !validateSchemaValue(branch, value, path),
    ).length
    if (matches !== 1) return `${path} must match exactly one allowed schema.`
  }
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : null
  if (allOf) {
    for (const branch of allOf) {
      if (!isPlainObject(branch)) continue
      const error = validateSchemaValue(branch, value, path)
      if (error) return error
    }
  }

  const expectedTypes = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((entry): entry is string => typeof entry === 'string')
      : []
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesSchemaType(value, type))) {
    return `${path} must be ${expectedTypes.join(' or ')}.`
  }

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    return `${path} must equal the configured constant.`
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(value, entry))) {
    return `${path} must be one of the configured enum values.`
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${path} must contain at least ${schema.minLength} characters.`
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${path} must contain at most ${schema.maxLength} characters.`
    }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} must be a finite number.`
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${path} must be at least ${schema.minimum}.`
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${path} must be at most ${schema.maximum}.`
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return `${path} must be greater than ${schema.exclusiveMinimum}.`
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      return `${path} must be less than ${schema.exclusiveMaximum}.`
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${path} must contain at least ${schema.minItems} items.`
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${path} must contain at most ${schema.maxItems} items.`
    }
    if (isPlainObject(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const error = validateSchemaValue(schema.items, value[index], `${path}[${index}]`)
        if (error) return error
      }
    } else if (Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const itemSchema = schema.items[index]
        if (!isPlainObject(itemSchema)) return `${path}[${index}] is not allowed.`
        const error = validateSchemaValue(itemSchema, value[index], `${path}[${index}]`)
        if (error) return error
      }
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      return `${path} must contain at least ${schema.minProperties} properties.`
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      return `${path} must contain at most ${schema.maxProperties} properties.`
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === 'string' && !Object.prototype.hasOwnProperty.call(value, required)) {
          return `${path}.${required} is required.`
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key]
      if (isPlainObject(childSchema)) {
        const error = validateSchemaValue(childSchema, child, `${path}.${key}`)
        if (error) return error
        continue
      }
      if (schema.additionalProperties === false) return `${path}.${key} is not allowed.`
      if (isPlainObject(schema.additionalProperties)) {
        const error = validateSchemaValue(schema.additionalProperties, child, `${path}.${key}`)
        if (error) return error
      }
    }
  }
  return null
}

function matchesSchemaType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isPlainObject(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function immediateError(
  call: ClientToolCall,
  code: string,
  message: string,
): ClientToolResult {
  return {
    version: HOST_TOOL_PROTOCOL_VERSION,
    callId: call.id,
    name: call.name,
    args: call.args,
    ok: false,
    error: { code, message },
    durationMs: 0,
  }
}

function executionId(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return `voice_${id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

function validateTool(tool: ClientTool): void {
  if (tool.version !== HOST_TOOL_PROTOCOL_VERSION) {
    throw new Error(`Client tool "${tool.name}" must use protocol version 1.`)
  }
  if (tool.name.length > 64 || !TOOL_NAME.test(tool.name)) {
    throw new Error(
      `Invalid client tool name "${tool.name}". Names must start with host_ or client_ and use lowercase letters, numbers, and underscores.`,
    )
  }
  if (!tool.description.trim() || tool.description.length > 1_000) {
    throw new Error(`Client tool "${tool.name}" must have a 1-1000 character description.`)
  }
  if (
    !tool.inputSchema ||
    typeof tool.inputSchema !== 'object' ||
    Array.isArray(tool.inputSchema) ||
    tool.inputSchema.type !== 'object'
  ) {
    throw new Error(`Client tool "${tool.name}" must have an object inputSchema with type "object".`)
  }
  validateJsonPayload(
    tool.inputSchema,
    `Client tool "${tool.name}" inputSchema`,
    MAX_HOST_TOOL_SCHEMA_BYTES,
    MAX_HOST_TOOL_SCHEMA_DEPTH,
  )
  validateSupportedSchema(tool.inputSchema, `Client tool "${tool.name}" inputSchema`)
  if (tool.constraints !== undefined) {
    if (!isPlainObject(tool.constraints)) {
      throw new Error(`Client tool "${tool.name}" constraints must be an object.`)
    }
    validateJsonPayload(
      tool.constraints,
      `Client tool "${tool.name}" constraints`,
      MAX_HOST_TOOL_SCHEMA_BYTES,
      MAX_HOST_TOOL_SCHEMA_DEPTH,
    )
  }
  if (tool.locality !== 'host') {
    throw new Error(`Client tool "${tool.name}" must use locality "host".`)
  }
  if (tool.effect !== 'read' && tool.effect !== 'navigate' && tool.effect !== 'mutate') {
    throw new Error(`Client tool "${tool.name}" has an invalid effect.`)
  }
  if (tool.consent !== 'none' && tool.consent !== 'session' && tool.consent !== 'per_call') {
    throw new Error(`Client tool "${tool.name}" has an invalid consent policy.`)
  }
  if (
    !Number.isInteger(tool.timeoutMs) ||
    tool.timeoutMs < 100 ||
    tool.timeoutMs > MAX_HOST_TOOL_TIMEOUT_MS
  ) {
    throw new Error(
      `Client tool "${tool.name}" timeoutMs must be an integer from 100-${MAX_HOST_TOOL_TIMEOUT_MS}.`,
    )
  }
  if (typeof tool.handler !== 'function') {
    throw new Error(`Client tool "${tool.name}" must have a handler.`)
  }
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return JSON.parse(serialized) as JsonValue
}

function toDefinition({
  version,
  name,
  description,
  inputSchema,
  locality,
  effect,
  consent,
  timeoutMs,
  constraints,
}: ClientTool): ClientToolDefinition {
  return {
    version,
    name,
    description,
    inputSchema,
    locality,
    effect,
    consent,
    timeoutMs,
    ...(constraints ? { constraints } : {}),
  }
}

function validateJsonPayload(
  value: unknown,
  label: string,
  maxBytes: number,
  maxDepth: number,
): void {
  const bytes = jsonByteLength(value)
  if (bytes === null) throw new Error(`${label} must be JSON-serializable.`)
  if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  const depth = jsonDepth(value)
  if (depth === null) throw new Error(`${label} must contain only finite JSON values.`)
  if (depth > maxDepth) throw new Error(`${label} exceeds maximum depth ${maxDepth}.`)
}

function validateSupportedSchema(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`)
  for (const keyword of Object.keys(value)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`${path}.${keyword} is not supported.`)
    }
  }

  const type = value.type
  const validType =
    type === undefined ||
    (typeof type === 'string' && SUPPORTED_SCHEMA_TYPES.has(type)) ||
    (Array.isArray(type) &&
      type.length > 0 &&
      type.every((entry) => typeof entry === 'string' && SUPPORTED_SCHEMA_TYPES.has(entry)) &&
      new Set(type).size === type.length)
  if (!validType) throw new Error(`${path}.type is not supported.`)
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 200)) {
    throw new Error(`${path}.title must be at most 200 characters.`)
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' || value.description.length > 1_000)
  ) {
    throw new Error(`${path}.description must be at most 1000 characters.`)
  }
  if (value.examples !== undefined && !Array.isArray(value.examples)) {
    throw new Error(`${path}.examples must be an array.`)
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    throw new Error(`${path}.enum must be a non-empty array.`)
  }

  if (value.properties !== undefined) {
    if (!isPlainObject(value.properties)) throw new Error(`${path}.properties must be an object.`)
    for (const [name, schema] of Object.entries(value.properties)) {
      if (!SCHEMA_PROPERTY_NAME.test(name)) {
        throw new Error(`${path}.properties contains an invalid property name.`)
      }
      validateSupportedSchema(schema, `${path}.properties.${name}`)
    }
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.some((entry) => typeof entry !== 'string') ||
      new Set(value.required).size !== value.required.length
    ) {
      throw new Error(`${path}.required must contain unique property names.`)
    }
    if (isPlainObject(value.properties)) {
      for (const name of value.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value.properties, name)) {
          throw new Error(`${path}.required references unknown property "${name}".`)
        }
      }
    }
  }
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== 'boolean' &&
    !isPlainObject(value.additionalProperties)
  ) {
    throw new Error(`${path}.additionalProperties must be a boolean or schema.`)
  }
  if (isPlainObject(value.additionalProperties)) {
    validateSupportedSchema(value.additionalProperties, `${path}.additionalProperties`)
  }

  for (const keyword of [
    'minProperties',
    'maxProperties',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
  ]) {
    const keywordValue = value[keyword]
    if (
      keywordValue !== undefined &&
      (typeof keywordValue !== 'number' || !Number.isInteger(keywordValue) || keywordValue < 0)
    ) {
      throw new Error(`${path}.${keyword} must be a non-negative integer.`)
    }
  }
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    const keywordValue = value[keyword]
    if (keywordValue !== undefined && (typeof keywordValue !== 'number' || !Number.isFinite(keywordValue))) {
      throw new Error(`${path}.${keyword} must be a finite number.`)
    }
  }

  if (value.items !== undefined) {
    if (isPlainObject(value.items)) {
      validateSupportedSchema(value.items, `${path}.items`)
    } else if (Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 16) {
      value.items.forEach((schema, index) => validateSupportedSchema(schema, `${path}.items[${index}]`))
    } else {
      throw new Error(`${path}.items must be a schema or an array of 1-16 schemas.`)
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const branches = value[keyword]
    if (branches === undefined) continue
    if (!Array.isArray(branches) || branches.length === 0 || branches.length > 16) {
      throw new Error(`${path}.${keyword} must contain 1-16 schemas.`)
    }
    branches.forEach((schema, index) => validateSupportedSchema(schema, `${path}.${keyword}[${index}]`))
  }
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string'
      ? new TextEncoder().encode(serialized).byteLength
      : null
  } catch {
    return null
  }
}

function jsonDepth(value: unknown, seen = new Set<object>()): number | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? 0 : null
  if (typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  const children = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.values(value)
      : null
  if (!children) return null
  let deepest = 0
  for (const child of children) {
    const childDepth = jsonDepth(child, seen)
    if (childDepth === null) return null
    deepest = Math.max(deepest, childDepth + 1)
  }
  seen.delete(value)
  return deepest
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class ToolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Client tool timed out after ${timeoutMs}ms.`)
    this.name = 'ToolTimeoutError'
  }
}
