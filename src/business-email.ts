const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
  'yahoo.fr', 'yahoo.de', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
  'hotmail.de', 'hotmail.it', 'outlook.com', 'outlook.co.uk', 'outlook.fr',
  'outlook.de', 'live.com', 'live.co.uk', 'live.fr', 'live.de', 'live.in',
  'msn.com', 'aol.com', 'aim.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com', 'tuta.io',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.com',
  'email.com', 'inbox.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'freenet.de', 't-online.de', 'mail.ru', 'bk.ru', 'list.ru', 'inbox.ru',
  'rediffmail.com', 'rediff.com', 'qq.com', '163.com', '126.com', 'sina.com',
  'naver.com', 'daum.net', 'hanmail.net', 'rambler.ru', 'ukr.net', 'bigmir.net',
  'cox.net', 'sbcglobal.net', 'verizon.net', 'att.net', 'comcast.net',
  'charter.net', 'bellsouth.net', 'earthlink.net', 'windstream.net',
  'centurylink.net', 'optonline.net', 'frontier.com', 'roadrunner.com',
  'rocketmail.com', 'ymail.com', 'fastmail.com', 'fastmail.fm', 'hushmail.com',
  'startmail.com', 'disroot.org', 'riseup.net', 'guerrillamail.com',
  'guerrillamail.de', 'grr.la', 'sharklasers.com', 'mailinator.com',
  'guerrillamail.info', 'yopmail.com', 'tempmail.com', 'throwaway.email',
  'temp-mail.org', 'fakeinbox.com', 'maildrop.cc', 'trashmail.com',
  'trashmail.net', 'dispostable.com', 'mailnesia.com', 'mailnator.com',
  'binkmail.com', 'bobmail.info', 'getnada.com', 'harakirimail.com', 'jetable.org',
])

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const VOWELS = /[aeiou]/i

/** Return a normalized hosted-widget-compatible business email, or null. */
export function normalizeBusinessEmail(value: string): string | null {
  const email = value.trim().toLowerCase().slice(0, 320)
  if (!email || !EMAIL_REGEX.test(email)) return null
  const [local, domain] = email.split('@')
  if (!local || !domain || local.length < 2 || !VOWELS.test(local)) return null
  const domainParts = domain.split('.')
  const tld = domainParts.at(-1)
  if (domainParts.length < 2 || !tld || tld.length < 2) return null
  if (PERSONAL_DOMAINS.has(domain)) return null
  if (['temp', 'trash', 'disposable', 'fake', 'guerrilla'].some((part) => domain.includes(part))) {
    return null
  }
  return email
}
