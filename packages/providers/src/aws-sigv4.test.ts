import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  toHex,
  uriEncode,
  canonicalUri,
  canonicalQueryString,
  canonicalHeaders,
  buildCanonicalRequest,
  credentialScope,
  stringToSign,
  deriveSigningKey,
  signStringToSign,
  buildAuthorizationHeader,
  formatAmzDate,
  signRequest,
} from './aws-sigv4.js';

describe('aws-sigv4 primitives', () => {
  it('sha256Hex empty payload matches known vector', async () => {
    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('sha256Hex of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('uriEncode leaves unreserved chars', () => {
    expect(uriEncode('abc-._~XYZ012')).toBe('abc-._~XYZ012');
  });

  it('uriEncode encodes specials uppercase hex', () => {
    expect(uriEncode('a b')).toBe('a%20b');
    expect(uriEncode('foo/bar', true)).toBe('foo%2Fbar');
    expect(uriEncode('foo/bar', false)).toBe('foo/bar');
  });

  it('canonicalUri encodes segments', () => {
    expect(canonicalUri('/assets/my id/original.jpg')).toBe(
      '/assets/my%20id/original.jpg'
    );
    expect(canonicalUri('/')).toBe('/');
  });

  it('canonicalQueryString sorts and encodes', () => {
    expect(canonicalQueryString({ b: '2', a: '1' })).toBe('a=1&b=2');
    expect(canonicalQueryString({ 'a b': 'c d' })).toBe('a%20b=c%20d');
  });

  it('canonicalHeaders lowercases sorts and trims', () => {
    const { canonicalHeaders: h, signedHeaders } = canonicalHeaders({
      'Content-Type': ' image/jpeg ',
      Host: 'example.com',
      'X-Amz-Date': '20260903T120000Z',
    });
    expect(signedHeaders).toBe('content-type;host;x-amz-date');
    expect(h).toContain('content-type:image/jpeg\n');
    expect(h).toContain('host:example.com\n');
  });

  it('buildCanonicalRequest joins with newlines', () => {
    const cr = buildCanonicalRequest({
      method: 'GET',
      uri: '/b/k',
      query: '',
      headers: 'host:ex\n',
      signedHeaders: 'host',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(cr.split('\n')).toHaveLength(6);
    expect(cr.startsWith('GET\n')).toBe(true);
  });

  it('credentialScope format', () => {
    expect(credentialScope('20260903', 'us-west-000', 's3')).toBe(
      '20260903/us-west-000/s3/aws4_request'
    );
  });

  it('formatAmzDate', () => {
    const d = new Date(Date.UTC(2026, 8, 3, 12, 0, 0));
    const { amzDate, dateStamp } = formatAmzDate(d);
    expect(dateStamp).toBe('20260903');
    expect(amzDate).toBe('20260903T120000Z');
  });
});

describe('aws-sigv4 key derivation + authorization (deterministic)', () => {
  // Fixed clock + fixed secret → stable signature for regression
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const accessKeyId = 'AKIDEXAMPLE';
  const region = 'us-east-1';
  const service = 's3';
  const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0)); // 20150830T123600Z (classic AWS example date family)

  it('deriveSigningKey produces 32-byte key', async () => {
    const key = await deriveSigningKey(secret, '20150830', region, service);
    expect(new Uint8Array(key).byteLength).toBe(32);
    expect(toHex(key).length).toBe(64);
  });

  it('signRequest produces Authorization with Credential scope', async () => {
    const signed = await signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      accessKeyId,
      secretAccessKey: secret,
      region,
      service,
      now,
    });
    expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
    expect(signed.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(signed.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(signed.headers['authorization']).toContain(
      `Credential=${accessKeyId}/20150830/${region}/${service}/aws4_request`
    );
    expect(signed.headers['authorization']).toContain('SignedHeaders=');
    expect(signed.headers['authorization']).toContain('Signature=');
    // Signature is 64 hex chars
    const sig = signed.headers['authorization']!.split('Signature=')[1]!;
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same inputs → same signature (deterministic)', async () => {
    const a = await signRequest({
      method: 'PUT',
      url: 'https://s3.example.test/bucket/assets/a1/original.jpg',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3]),
      accessKeyId: 'kid',
      secretAccessKey: 'secret',
      region: 'us-west-000',
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    });
    const b = await signRequest({
      method: 'PUT',
      url: 'https://s3.example.test/bucket/assets/a1/original.jpg',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3]),
      accessKeyId: 'kid',
      secretAccessKey: 'secret',
      region: 'us-west-000',
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    });
    expect(a.headers['authorization']).toBe(b.headers['authorization']);
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('buildAuthorizationHeader format', () => {
    const h = buildAuthorizationHeader({
      accessKeyId: 'AK',
      scope: '20260101/r/s3/aws4_request',
      signedHeaders: 'host;x-amz-date',
      signature: 'abc',
    });
    expect(h).toBe(
      'AWS4-HMAC-SHA256 Credential=AK/20260101/r/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc'
    );
  });

  it('stringToSign structure', async () => {
    const hash = await sha256Hex('canonical');
    const sts = stringToSign('20260101T000000Z', '20260101/r/s3/aws4_request', hash);
    expect(sts.split('\n')[0]).toBe('AWS4-HMAC-SHA256');
    expect(sts.split('\n')[3]).toBe(hash);
  });
});
