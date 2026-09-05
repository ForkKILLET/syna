// p11 — normalizeDomain edge cases (observations; the checks below express the claims that held).
// Run: node <this file>
import { normalizeDomain, requestHost } from '../../../../apps/hyla-mini/dist/index.js'

let failed = 0
const check = (name, ok, observed) => { failed += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${observed === undefined ? '' : ` -- ${JSON.stringify(observed)}`}`) }

const samples = ['Example.COM', 'example.com:8080', 'example.com.', 'EXAMPLE.com:443.', 'example.com..', '例子.测试', 'xn--fsqu00a.xn--0zwm56d', '0x7f.1', '1.2.3.4', '999.1.1.1', '[::1]', 'a/b.com', 'a..b', 'a b', '', 'localhost']
for (const sample of samples) console.log(`normalizeDomain(${JSON.stringify(sample)}) → ${JSON.stringify(normalizeDomain(sample))}`)

check('spellings of one host normalize alike (case, port, one trailing dot)', ['Example.COM', 'example.com:8080', 'example.com.'].every(sample => normalizeDomain(sample) === 'example.com'))
check('a Unicode label and its punycode form are one claim', normalizeDomain('例子.测试') === normalizeDomain('xn--fsqu00a.xn--0zwm56d') && normalizeDomain('例子.测试') !== undefined)
check('URL delimiters, spaces and empty strings are refused', ['a/b.com', 'a b', ''].every(sample => normalizeDomain(sample) === undefined))
check('the request path normalizes the same way as the claim (host header "EXAMPLE.com.:443")', requestHost({ host: 'EXAMPLE.com.:443' }, false) === 'example.com', requestHost({ host: 'EXAMPLE.com.:443' }, false))
// Observations, not defects: the port is stripped before the trailing dot, so "host:443." (dot after the port) is refused
// while "host.:443" is accepted — both sides (claim and request) agree, and parseSiteConfig refuses the former at save time;
// a second trailing dot survives ("example.com.." → "example.com."), a claim no request can match since request hosts lose
// exactly one dot too; an empty label ("a..b") passes url.domainToASCII; IPv4 spellings are canonicalized ("0x7f.1" → "127.0.0.1").
console.log(`observations: "EXAMPLE.com:443." → ${JSON.stringify(normalizeDomain('EXAMPLE.com:443.'))}; "example.com.." → ${JSON.stringify(normalizeDomain('example.com..'))}; "a..b" → ${JSON.stringify(normalizeDomain('a..b'))}; "0x7f.1" → ${JSON.stringify(normalizeDomain('0x7f.1'))}`)
process.exitCode = failed === 0 ? 0 : 1
