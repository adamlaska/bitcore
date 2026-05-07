'use strict';

const BN = require('../lib/crypto/bn');
const Point = require('../lib/crypto/point');
const PrivateKey = require('../lib/privatekey');
const TaggedHash = require('../lib/crypto/taggedhash');

const privateKey = new PrivateKey('123456789abcdef123456789abcdef123456789abcdef123456789abcdef');
const publicKey = privateKey.toPublicKey();
const merkleRoot = Buffer.from('ffffffffeeeeeeeeddddddddccccccccbbbbbbbbaaaaaaaa9999999988888888', 'hex');
const order = Point.getN();
const point = publicKey.point;

const fastIterations = Number(process.env.FAST_ITERATIONS || 500000);
const hashIterations = Number(process.env.HASH_ITERATIONS || 200000);
const tweakIterations = Number(process.env.TWEAK_ITERATIONS || 50000);

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
  const lastText = Buffer.isBuffer(last) ? last.toString('hex') : JSON.stringify(last);
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

function computeTapTweakHashLegacy(pubKey, root) {
  const taggedWriter = new TaggedHash('TapTweak');
  taggedWriter.write(pubKey.point.x.toBuffer({ size: 32 }));
  if (root) {
    taggedWriter.write(root);
  }
  const tweakHash = taggedWriter.finalize();
  if (!BN.fromBuffer(tweakHash).lt(order)) {
    throw new Error('TapTweak hash failed secp256k1 order check');
  }
  return tweakHash;
}

function computeTapTweakHashAccessor(pubKey, root) {
  const taggedWriter = new TaggedHash('TapTweak');
  taggedWriter.write(pubKey.point.getX().toBuffer({ size: 32 }));
  if (root) {
    taggedWriter.write(root);
  }
  const tweakHash = taggedWriter.finalize();
  if (!BN.fromBuffer(tweakHash).lt(order)) {
    throw new Error('TapTweak hash failed secp256k1 order check');
  }
  return tweakHash;
}

function createPublicTapTweakLegacy(pubKey, root) {
  const tweak = new BN(computeTapTweakHashLegacy(pubKey, root));
  const Q = pubKey.point.liftX().add(Point.getG().mul(tweak));
  return {
    parity: Q.y.isEven() ? 0 : 1,
    tweakedPubKey: Q.x.toBuffer()
  };
}

function createPublicTapTweakAccessor(pubKey, root) {
  const tweak = new BN(computeTapTweakHashAccessor(pubKey, root));
  const Q = pubKey.point.liftX().add(Point.getG().mul(tweak));
  return {
    parity: Q.y.isEven() ? 0 : 1,
    tweakedPubKey: Q.getX().toBuffer({ size: 32 })
  };
}

function createPrivateTapTweakLegacy(privKey, root) {
  const P = Point.getG().mul(privKey.bn);
  const secKey = P.y.isEven() ? privKey.bn : order.sub(privKey.bn);
  const taggedWriter = new TaggedHash('TapTweak');
  taggedWriter.write(P.x.toBuffer({ size: 32 }));
  if (root) {
    taggedWriter.write(root);
  }
  const tweakHash = taggedWriter.finalize();
  if (!BN.fromBuffer(tweakHash).lt(order)) {
    throw new Error('TapTweak hash failed secp256k1 order check');
  }
  return {
    tweakedPrivKey: secKey.add(new BN(tweakHash)).mod(order).toBuffer({ size: 32 })
  };
}

function createPrivateTapTweakAccessor(privKey, root) {
  const P = Point.getG().mul(privKey.bn);
  const secKey = P.y.isEven() ? privKey.bn : order.sub(privKey.bn);
  const taggedWriter = new TaggedHash('TapTweak');
  taggedWriter.write(P.getX().toBuffer({ size: 32 }));
  if (root) {
    taggedWriter.write(root);
  }
  const tweakHash = taggedWriter.finalize();
  if (!BN.fromBuffer(tweakHash).lt(order)) {
    throw new Error('TapTweak hash failed secp256k1 order check');
  }
  return {
    tweakedPrivKey: secKey.add(new BN(tweakHash)).mod(order).toBuffer({ size: 32 })
  };
}

console.log('Taproot Point x accessor benchmarks');
console.log('-----------------------------------');
console.log('Invariant check:');
console.log('  publicKey.point instanceof Point:', point instanceof Point);
console.log('  publicKey.point.x instanceof bitcore BN:', point.x instanceof BN);
console.log('  publicKey.point.getX() instanceof bitcore BN:', point.getX() instanceof BN);
console.log('  current computeTapTweakHash matches accessor:', publicKey.computeTapTweakHash(merkleRoot).equals(computeTapTweakHashAccessor(publicKey, merkleRoot)));
console.log('  current createTapTweak matches accessor:', publicKey.createTapTweak(merkleRoot).tweakedPubKey.equals(createPublicTapTweakAccessor(publicKey, merkleRoot).tweakedPubKey));
console.log('  current private createTapTweak matches accessor:', privateKey.createTapTweak(merkleRoot).tweakedPrivKey.equals(createPrivateTapTweakAccessor(privateKey, merkleRoot).tweakedPrivKey));
console.log('');

const legacyPublicXBuffer = bench('legacy public x buffer: publicKey.point.x.toBuffer({ size: 32 })', fastIterations, () => {
  return publicKey.point.x.toBuffer({ size: 32 });
});

const accessorPublicXBuffer = bench('accessor public x buffer: publicKey.point.getX().toBuffer({ size: 32 })', fastIterations, () => {
  return publicKey.point.getX().toBuffer({ size: 32 });
});

summarizePair('public x buffer', legacyPublicXBuffer, accessorPublicXBuffer);

const legacyComputeTapTweakHash = bench('legacy computeTapTweakHash: point.x.toBuffer({ size: 32 })', hashIterations, () => {
  return computeTapTweakHashLegacy(publicKey, merkleRoot);
});

const accessorComputeTapTweakHash = bench('accessor computeTapTweakHash: point.getX().toBuffer({ size: 32 })', hashIterations, () => {
  return computeTapTweakHashAccessor(publicKey, merkleRoot);
});

summarizePair('computeTapTweakHash', legacyComputeTapTweakHash, accessorComputeTapTweakHash);

const legacyPublicCreateTapTweak = bench('legacy public createTapTweak: Q.x.toBuffer()', tweakIterations, () => {
  return createPublicTapTweakLegacy(publicKey, merkleRoot).tweakedPubKey;
});

const accessorPublicCreateTapTweak = bench('accessor public createTapTweak: Q.getX().toBuffer({ size: 32 })', tweakIterations, () => {
  return createPublicTapTweakAccessor(publicKey, merkleRoot).tweakedPubKey;
});

summarizePair('public createTapTweak', legacyPublicCreateTapTweak, accessorPublicCreateTapTweak);

bench('current public createTapTweak', tweakIterations, () => {
  return publicKey.createTapTweak(merkleRoot).tweakedPubKey;
});

const legacyPrivateCreateTapTweak = bench('legacy private createTapTweak: P.x.toBuffer({ size: 32 })', tweakIterations, () => {
  return createPrivateTapTweakLegacy(privateKey, merkleRoot).tweakedPrivKey;
});

const accessorPrivateCreateTapTweak = bench('accessor private createTapTweak: P.getX().toBuffer({ size: 32 })', tweakIterations, () => {
  return createPrivateTapTweakAccessor(privateKey, merkleRoot).tweakedPrivKey;
});

summarizePair('private createTapTweak', legacyPrivateCreateTapTweak, accessorPrivateCreateTapTweak);

bench('current private createTapTweak', tweakIterations, () => {
  return privateKey.createTapTweak(merkleRoot).tweakedPrivKey;
});
