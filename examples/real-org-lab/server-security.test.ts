import { describe, expect, test } from 'bun:test'
import { safeConvincedApiBase, safeHttpsBase } from './server-security'

describe('real organization lab server origins', () => {
  test('accepts production HTTPS and explicit HTTP loopback API origins', () => {
    expect(safeConvincedApiBase('https://app.getconvinced.ai')).toBe('https://app.getconvinced.ai')
    expect(safeConvincedApiBase('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(safeConvincedApiBase('http://localhost:3000')).toBe('http://localhost:3000')
    expect(safeConvincedApiBase('http://[::1]:3000')).toBe('http://[::1]:3000')
  })

  test('rejects non-loopback HTTP, lookalikes, credentials, and URL components', () => {
    for (const value of [
      'http://app.getconvinced.ai',
      'http://0.0.0.0:3000',
      'http://localhost.example.com:3000',
      'http://127.0.0.1.example.com:3000',
      'http://user:secret@127.0.0.1:3000',
      'http://127.0.0.1:3000/api',
      'http://127.0.0.1:3000?target=production',
    ]) {
      expect(() => safeConvincedApiBase(value)).toThrow()
    }
  })

  test('keeps dashboard links HTTPS-only', () => {
    expect(safeHttpsBase('https://app.getconvinced.ai')).toBe('https://app.getconvinced.ai')
    expect(() => safeHttpsBase('http://127.0.0.1:3000')).toThrow()
  })
})
