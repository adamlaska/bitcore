'use strict';

const BN = require('../lib/crypto/bn');
const Point = require('../lib/crypto/point');
const PrivateKey = require('../lib/privatekey');
const PublicKey = require('../lib/publickey');
const Schnorr = require('../lib/crypto/schnorr');
const TaggedHash = require('../lib/crypto/taggedhash');

const privateKey = new PrivateKey('123456789abcdef123456789abcdef123456789abcdef123456789abcdef');
const publicKey = new PublicKey(privateKey);
const publicKeyBuffer = publicKey.point.getX().toBuffer({ size: 32 });
const message = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const aux = Buffer.alloc(32, 7);
const signature = Schnorr.sign(privateKey, message, aux);
const r = BN.fromBuffer(signature.slice(0, 32));
const P = Point.fromX(false, BN.fromBuffer(publicKeyBuffer)).liftX();
const n = Point.getN();

const fastIterations = Number(process.env.FAST_ITERATIONS || 500000);
const hashIterations = Number(process.env.HASH_ITERATIONS || 200000);
const verifyIterations = Number(process.env.VERIFY_ITERATIONS || 5000);

function bench(name, iterations, fn) {
  const warmup = Math.min(10000, Math.max(100, Math.floor(iterations / 10)));
  for (let i = 0; i < warmup; i++) fn();

  const start = process.hrtime.bigint();
  let last;
  for (let i = 0; i < iterations; i++) {
    last = fn();
  }
  const end = process.hrtime.bigint();

  const ns = Number(end - start);
  const lastText = Buffer.isBuffer(last) ? last.toString('hex') : String(last);
  console.log(`${name}:`);
  console.log(`  iterations: ${iterations}`);
  console.log(`  total:      ${(ns / 1e6).toFixed(2)} ms`);
  console.log(`  avg:        ${(ns / iterations).toFixed(2)} ns/op`);
  console.log(`  last:       ${lastText}`);
  return { name, iterations, ns, avgNs: ns / iterations, last };
}

function summarizePair(name, left, right, leftLabel, rightLabel) {
  leftLabel = leftLabel || 'legacy';
  rightLabel = rightLabel || 'accessor';
  const diff = right.avgNs - left.avgNs;
  const percent = (diff / left.avgNs) * 100;
  const faster = diff <= 0 ? `${rightLabel} faster` : `${rightLabel} slower`;
  console.log(`${name} summary:`);
  console.log(`  ${leftLabel} avg:   ${left.avgNs.toFixed(2)} ns/op`);
  console.log(`  ${rightLabel} avg: ${right.avgNs.toFixed(2)} ns/op`);
  console.log(`  difference:   ${diff.toFixed(2)} ns/op (${percent.toFixed(2)}%, ${faster})`);
  console.log('');
}

function getELegacy(rValue, point, msg) {
  const hash = new TaggedHash(
    'BIP0340/challenge',
    Buffer.concat([
      rValue.toBuffer({ size: 32 }),
      point.x.toBuffer({ size: 32 }),
      msg
    ])
  ).finalize();
  return new BN(hash).mod(n);
}

function getEAccessor(rValue, point, msg) {
  const hash = new TaggedHash(
    'BIP0340/challenge',
    Buffer.concat([
      rValue.toBuffer({ size: 32 }),
      point.getX().toBuffer({ size: 32 }),
      msg
    ])
  ).finalize();
  return new BN(hash).mod(n);
}

console.log('Schnorr Point x accessor benchmarks');
console.log('-----------------------------------');
console.log('Invariant check:');
console.log('  publicKey.point instanceof Point:', publicKey.point instanceof Point);
console.log('  publicKey.point.x instanceof bitcore BN:', publicKey.point.x instanceof BN);
console.log('  publicKey.point.getX() instanceof bitcore BN:', publicKey.point.getX() instanceof BN);
console.log('  Schnorr.verify(PublicKey):', Schnorr.verify(publicKey, message, signature));
console.log('  Schnorr.verify(Buffer):', Schnorr.verify(publicKeyBuffer, message, signature));
console.log('');

const legacyPubkeyConversion = bench('legacy pubkey conversion: publicKey.point.x.toBuffer({ size: 32 })', fastIterations, () => {
  return publicKey.point.x.toBuffer({ size: 32 });
});

const accessorPubkeyConversion = bench('accessor pubkey conversion: publicKey.point.getX().toBuffer({ size: 32 })', fastIterations, () => {
  return publicKey.point.getX().toBuffer({ size: 32 });
});

summarizePair('pubkey conversion', legacyPubkeyConversion, accessorPubkeyConversion);

const legacyChallengeHash = bench('legacy challenge hash: P.x.toBuffer({ size: 32 })', hashIterations, () => {
  return getELegacy(r, P, message);
});

const accessorChallengeHash = bench('accessor challenge hash: P.getX().toBuffer({ size: 32 })', hashIterations, () => {
  return getEAccessor(r, P, message);
});

summarizePair('challenge hash', legacyChallengeHash, accessorChallengeHash);

const publicKeyVerify = bench('current full verify with PublicKey input', verifyIterations, () => {
  return Schnorr.verify(publicKey, message, signature);
});

const bufferVerify = bench('current full verify with 32-byte Buffer input', verifyIterations, () => {
  return Schnorr.verify(publicKeyBuffer, message, signature);
});

summarizePair('current full verify PublicKey vs Buffer', publicKeyVerify, bufferVerify, 'PublicKey', 'Buffer');
