import {
  BitcoreLib as Bitcore,
  BitcoreLibCash 
} from 'crypto-wallet-core';
import _ from 'lodash';
import { singleton } from 'preconditions';
import { Constants, Utils } from './common';
import log from './log';

const $ = singleton();
const BCHAddress = BitcoreLibCash.Address;

/**
 * @desc Verifier constructor. Checks data given by the server
 *
 * @constructor
 */
export class Verifier {
  private static _useRegtest: boolean = false;

  static useRegtest() {
    this._useRegtest = true;
  }

  static useTestnet() {
    this._useRegtest = false;
  }
  
  /**
   * Check address
   *
   * @param {Function} credentials
   * @param {String} address
   * @returns {Boolean} true or false
   */
  static checkAddress(credentials, address, escrowInputs?) {
    $.checkState(credentials.isComplete(), 'Failed state: credentials at <checkAddress>');

    let network = credentials.network;
    if (network === 'testnet' && this._useRegtest) {
      network = 'regtest';
    }

    var local = Utils.deriveAddress(
      address.type || credentials.addressType,
      credentials.publicKeyRing,
      address.path,
      credentials.m,
      network,
      credentials.chain,
      escrowInputs,
      credentials.hardwareSourcePublicKey,
      credentials.clientDerivedPublicKey
    );
    return (
      local.address == address.address &&
      _.difference(local.publicKeys, address.publicKeys).length === 0
    );
  }

  /**
   * Check copayers
   *
   * @param {Function} credentials
   * @param {Array} copayers
   * @returns {Boolean} true or false
   */
  static checkCopayers(credentials, copayers) {
    $.checkState(
      credentials.walletPrivKey,
      'Failed state: credentials at <checkCopayers>'
    );
    var walletPubKey = Bitcore.PrivateKey.fromString(credentials.walletPrivKey)
      .toPublicKey()
      .toString();

    if (copayers.length != credentials.n) {
      log.error('Missing public keys in server response');
      return false;
    }

    // Repeated xpub kes?
    var uniq = [];
    var error;
    for (const copayer of copayers || []) {
      if (error) return;

      if (uniq[copayers.xPubKey]++) {
        log.error('Repeated public keys in server response');
        error = true;
      }

      // Not signed pub keys
      if (
        !(copayer.encryptedName || copayer.name) ||
        !copayer.xPubKey ||
        !copayer.requestPubKey ||
        !copayer.signature
      ) {
        log.error('Missing copayer fields in server response');
        error = true;
      } else {
        var hash = Utils.getCopayerHash(
          copayer.encryptedName || copayer.name,
          copayer.xPubKey,
          copayer.requestPubKey
        );
        if (!Utils.verifyMessage(hash, copayer.signature, walletPubKey)) {
          log.error('Invalid signatures in server response');
          error = true;
        }
      }
    }

    if (error) return false;

    if (!copayers.map(c => c.xPubKey).includes(credentials.xPubKey)) {
      log.error('Server response does not contains our public keys');
      return false;
    }
    return true;
  }

  static checkProposalCreation(args, txp, encryptingKey) {
    var strEqual = (str1, str2) => {
      return (!str1 && !str2) || str1 === str2;
    };

    if (txp.outputs.length != args.outputs.length) return false;

    for (var i = 0; i < txp.outputs.length; i++) {
      var o1 = txp.outputs[i];
      var o2 = args.outputs[i];
      if (!strEqual(o1.toAddress, o2.toAddress)) return false;
      if (!strEqual(o1.script, o2.script)) return false;
      if (o1.amount != o2.amount) return false;
      var decryptedMessage = null;
      try {
        decryptedMessage = Utils.decryptMessage(o2.message, encryptingKey);
      } catch (e) {
        return false;
      }
      if (!strEqual(o1.message, decryptedMessage)) return false;
    }

    var changeAddress;
    if (txp.changeAddress) {
      changeAddress = txp.changeAddress.address;
    }
    if (args.changeAddress && !strEqual(changeAddress, args.changeAddress))
      return false;
    if (typeof args.feePerKb === 'number' && txp.feePerKb != args.feePerKb)
      return false;
    if (!strEqual(txp.payProUrl, args.payProUrl)) return false;

    var decryptedMessage = null;
    try {
      decryptedMessage = Utils.decryptMessage(args.message, encryptingKey);
    } catch (e) {
      return false;
    }
    if (!strEqual(txp.message, decryptedMessage)) return false;
    if (
      (args.customData || txp.customData) &&
      !_.isEqual(txp.customData, args.customData)
    )
      return false;

    return true;
  }

  static checkTxProposalSignature(credentials, txp) {
    $.checkArgument(txp.creatorId);
    $.checkState(
      credentials.isComplete(),
      'Failed state: credentials at checkTxProposalSignature'
    );

    var chain = txp.chain?.toLowerCase() || Utils.getChain(txp.coin); // getChain -> backwards compatibility
    var creatorKeys = (credentials.publicKeyRing || []).find(item => {
      if (Utils.xPubToCopayerId(chain, item.xPubKey) === txp.creatorId)
        return true;
    });

    if (!creatorKeys) return false;
    var creatorSigningPubKey;

    // If the txp using a selfsigned pub key?
    if (txp.proposalSignaturePubKey) {
      // Verify it...
      if (
        !Utils.verifyRequestPubKey(
          txp.proposalSignaturePubKey,
          txp.proposalSignaturePubKeySig,
          creatorKeys.xPubKey
        )
      )
        return false;

      creatorSigningPubKey = txp.proposalSignaturePubKey;
    } else {
      creatorSigningPubKey = creatorKeys.requestPubKey;
    }
    if (!creatorSigningPubKey) return false;

    var hash;
    if (parseInt(txp.version) >= 3) {
      var t = Utils.buildTx(txp);
      hash = t.uncheckedSerialize();
    } else {
      throw new Error('Transaction proposal not supported');
    }

    log.debug(
      'Regenerating & verifying tx proposal hash -> Hash: ',
      hash,
      ' Signature: ',
      txp.proposalSignature
    );
  
    const verified = Utils.verifyMessage(hash, txp.proposalSignature, creatorSigningPubKey);
    if (!verified && !txp.prePublishRaw)
        return false;
    
    if (!verified && txp.prePublishRaw && !Utils.verifyMessage(txp.prePublishRaw, txp.proposalSignature, creatorSigningPubKey))
        return false;

    if (Constants.UTXO_CHAINS.includes(chain)) {
      if (!this.checkAddress(credentials, txp.changeAddress)) {
        return false;
      }
      if (
        txp.escrowAddress &&
        !this.checkAddress(credentials, txp.escrowAddress, txp.inputs)
      ) {
        return false;
      }
    }

    return true;
  }

  static checkPaypro(txp, payproOpts) {
    var toAddress, amount, feeRate;

    if (parseInt(txp.version) >= 3) {
      toAddress = txp.outputs[0].toAddress;
      amount = txp.amount;
      if (txp.feePerKb) {
        feeRate = txp.feePerKb / 1024;
      }
    } else {
      toAddress = txp.toAddress;
      amount = txp.amount;
    }

    if (amount != (payproOpts.instructions || []).reduce((sum, i) => sum += i.amount, 0)) return false;

    if (txp.coin == 'btc' && toAddress != payproOpts.instructions[0].toAddress)
      return false;

    // Workaround for cashaddr/legacy address problems...
    if (
      txp.coin == 'bch' &&
      new BCHAddress(toAddress).toString() !=
        new BCHAddress(payproOpts.instructions[0].toAddress).toString()
    )
      return false;

    // this generates problems...
    //  if (feeRate && payproOpts.requiredFeeRate &&
    //      feeRate < payproOpts.requiredFeeRate)
    //  return false;

    return true;
  }

  /**
   * Check transaction proposal
   *
   * @param {Function} credentials
   * @param {Object} txp
   * @param {Object} Optional: paypro
   * @param {Boolean} isLegit
   */
  static checkTxProposal(credentials, txp, opts) {
    opts = opts || {};

    if (!this.checkTxProposalSignature(credentials, txp)) return false;

    if (opts.paypro && !this.checkPaypro(txp, opts.paypro)) return false;

    return true;
  }
}
