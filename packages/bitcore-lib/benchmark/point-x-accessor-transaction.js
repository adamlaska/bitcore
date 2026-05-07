'use strict';

const BN = require('../lib/crypto/bn');
const Point = require('../lib/crypto/point');
const PrivateKey = require('../lib/privatekey');
const PublicKey = require('../lib/publickey');
const Signature = require('../lib/crypto/signature');
const Transaction = require('../lib/transaction/transaction');
const SighashSchnorr = require('../lib/transaction/sighashschnorr');

const privateKey = new PrivateKey('123456789abcdef123456789abcdef123456789abcdef123456789abcdef');
const publicKey = new PublicKey(privateKey);
const publicKeyBuffer = publicKey.point.getX().toBuffer({ size: 32 });
const signatureBuffer = Buffer.concat([
  Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex'),
  Buffer.from('2222222222222222222222222222222222222222222222222222222222222222', 'hex')
]);
const signature = Signature.fromSchnorr(signatureBuffer);
const tx = Object.create(Transaction.prototype);
const originalVerify = SighashSchnorr.verify;

const fastIterations = Number(process.env.FAST_ITERATIONS || 500000);
const methodIterations = Number(process.env.METHOD_ITERATIONS || 500000);

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

function checkSchnorrSignatureLegacy(sig, pubkey, nin, sigversion, execdata) {
  if (pubkey instanceof PublicKey) {
    pubkey = pubkey.point.x.toBuffer();
  }
  if (!pubkey || pubkey.length !== 32) {
    throw new Error('Schnorr signatures have 32-byte public keys. The caller is responsible for enforcing this.');
  }
  if (Buffer.isBuffer(sig)) {
    if (sig.length !== 64 && sig.length !== 65) {
      return false;
    }
    sig = Signature.fromSchnorr(sig);
  }
  if (!sig.isSchnorr) {
    throw new Error('Signature must be schnorr');
  }
  return !!SighashSchnorr.verify(this, sig, pubkey, sigversion, nin, execdata);
}

SighashSchnorr.verify = function() {
  return true;
};

process.on('exit', function() {
  SighashSchnorr.verify = originalVerify;
});

console.log('Transaction Schnorr Point x accessor benchmarks');
console.log('------------------------------------------------');
console.log('Invariant check:');
console.log('  publicKey.point instanceof Point:', publicKey.point instanceof Point);
console.log('  publicKey.point.x instanceof bitcore BN:', publicKey.point.x instanceof BN);
console.log('  publicKey.point.getX() instanceof bitcore BN:', publicKey.point.getX() instanceof BN);
console.log('  legacy public key length:', publicKey.point.x.toBuffer().length);
console.log('  accessor public key length:', publicKey.point.getX().toBuffer({ size: 32 }).length);
console.log('  current checkSchnorrSignature(PublicKey):', tx.checkSchnorrSignature(signature, publicKey, 0, Signature.Version.TAPROOT, {}));
console.log('  current checkSchnorrSignature(Buffer):', tx.checkSchnorrSignature(signature, publicKeyBuffer, 0, Signature.Version.TAPROOT, {}));
console.log('');

const legacyPubkeyConversion = bench('legacy pubkey conversion: publicKey.point.x.toBuffer()', fastIterations, () => {
  return publicKey.point.x.toBuffer();
});

const accessorPubkeyConversion = bench('accessor pubkey conversion: publicKey.point.getX().toBuffer({ size: 32 })', fastIterations, () => {
  return publicKey.point.getX().toBuffer({ size: 32 });
});

summarizePair('pubkey conversion', legacyPubkeyConversion, accessorPubkeyConversion);

const legacyCheckSchnorrSignature = bench('legacy checkSchnorrSignature with PublicKey input', methodIterations, () => {
  return checkSchnorrSignatureLegacy.call(tx, signature, publicKey, 0, Signature.Version.TAPROOT, {});
});

const currentCheckSchnorrSignature = bench('current checkSchnorrSignature with PublicKey input', methodIterations, () => {
  return tx.checkSchnorrSignature(signature, publicKey, 0, Signature.Version.TAPROOT, {});
});

summarizePair('checkSchnorrSignature PublicKey input', legacyCheckSchnorrSignature, currentCheckSchnorrSignature, 'legacy', 'current');

const currentBufferCheckSchnorrSignature = bench('current checkSchnorrSignature with 32-byte Buffer input', methodIterations, () => {
  return tx.checkSchnorrSignature(signature, publicKeyBuffer, 0, Signature.Version.TAPROOT, {});
});

summarizePair('current checkSchnorrSignature PublicKey vs Buffer', currentCheckSchnorrSignature, currentBufferCheckSchnorrSignature, 'PublicKey', 'Buffer');
