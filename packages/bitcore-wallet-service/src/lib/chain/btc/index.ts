import * as async from 'async';
import { BitcoreLib } from 'crypto-wallet-core';
import _ from 'lodash';
import { WalletService } from 'src/lib/server';
import { IChain } from '..';
import config from '../../../config';
import { Common } from '../../common';
import { ClientError } from '../../errors/clienterror';
import { Errors } from '../../errors/errordefinitions';
import logger from '../../logger';
import { IWallet, TxProposal } from '../../model';

const $ = require('preconditions').singleton();
const Constants = Common.Constants;
const Utils = Common.Utils;
const Defaults = Common.Defaults;

export class BtcChain implements IChain {
  protected sizeEstimationMargin: number;
  protected inputSizeEstimationMargin: number;

  constructor(private bitcoreLib = BitcoreLib) {
    this.sizeEstimationMargin = config.btc?.sizeEstimationMargin ?? 0.01;
    this.inputSizeEstimationMargin = config.btc?.inputSizeEstimationMargin ?? 2;
  }

  getSizeSafetyMargin(opts: any = {}): number {
    if (opts.conservativeEstimation) {
      return this.sizeEstimationMargin;
    }
    return 0;
  }

  getInputSizeSafetyMargin(opts: any = {}): number {
    if (opts.conservativeEstimation) {
      return this.inputSizeEstimationMargin;
    }
    return 0;
  }

  getWalletBalance(server: WalletService, wallet, opts, cb) {
    server.getUtxosForCurrentWallet(
      {
        coin: opts.coin,
        addresses: opts.addresses
      },
      (err, utxos) => {
        if (err) return cb(err);

        const balance = {
          ...this.totalizeUtxos(utxos),
          byAddress: []
        };

        // Compute balance by address
        const byAddress = {};
        _.each(_.keyBy(_.sortBy(utxos, 'address'), 'address'), (value, key) => {
          byAddress[key] = {
            address: key,
            path: value.path,
            amount: 0
          };
        });

        _.each(utxos, utxo => {
          byAddress[utxo.address].amount += utxo.satoshis;
        });

        balance.byAddress = _.values(byAddress);

        return cb(null, balance);
      }
    );
  }

  // opts.payProUrl => only to use different safety margin or not
  getWalletSendMaxInfo(server: WalletService, wallet, opts, cb) {
    server.getUtxosForCurrentWallet({}, (err, utxos) => {
      if (err) return cb(err);

      const MAX_TX_SIZE_IN_KB = Defaults.MAX_TX_SIZE_IN_KB_BTC;

      const info = {
        size: 0,
        amount: 0,
        fee: 0,
        feePerKb: 0,
        inputs: [],
        utxosBelowFee: 0,
        amountBelowFee: 0,
        utxosAboveMaxSize: 0,
        amountAboveMaxSize: 0
      };

      let inputs = _.reject(utxos, 'locked');
      if (!!opts.excludeUnconfirmedUtxos) {
        inputs = _.filter(inputs, 'confirmations');
      }
      inputs = _.sortBy(inputs, input => {
        return -input.satoshis;
      });

      if (_.isEmpty(inputs)) return cb(null, info);

      server._getFeePerKb(wallet, opts, (err, feePerKb) => {
        if (err) return cb(err);

        info.feePerKb = feePerKb;

        const txp = TxProposal.create({
          walletId: server.walletId,
          coin: wallet.coin,
          addressType: wallet.addressType,
          network: wallet.network,
          walletM: wallet.m,
          walletN: wallet.n,
          feePerKb
        });

        const baseTxpSize = this.getEstimatedSize(txp, { conservativeEstimation: true });
        const sizePerInput = this.getEstimatedSizeForSingleInput(txp, { conservativeEstimation: true });
        const feePerInput = (sizePerInput * txp.feePerKb) / 1000;

        const partitionedByAmount = _.partition(inputs, input => {
          return input.satoshis > feePerInput;
        });

        info.utxosBelowFee = partitionedByAmount[1].length;
        info.amountBelowFee = _.sumBy(partitionedByAmount[1], 'satoshis');
        inputs = partitionedByAmount[0];

        _.each(inputs, (input, i) => {
          const sizeInKb = (baseTxpSize + (i + 1) * sizePerInput) / 1000;
          if (sizeInKb > MAX_TX_SIZE_IN_KB) {
            info.utxosAboveMaxSize = inputs.length - i;
            info.amountAboveMaxSize = _.sumBy(_.slice(inputs, i), 'satoshis');
            return false;
          }
          txp.inputs.push(input);
        });

        if (_.isEmpty(txp.inputs)) return cb(null, info);

        const fee = this.getEstimatedFee(txp, { conservativeEstimation: true });
        const amount = _.sumBy(txp.inputs, 'satoshis') - fee;

        if (amount < Defaults.MIN_OUTPUT_AMOUNT) return cb(null, info);

        info.size = this.getEstimatedSize(txp, { conservativeEstimation: true });
        info.fee = fee;
        info.amount = amount;

        if (opts.returnInputs) {
          info.inputs = _.shuffle(txp.inputs);
        }

        return cb(null, info);
      });
    });
  }

  getDustAmountValue() {
    return this.bitcoreLib.Transaction.DUST_AMOUNT;
  }

  getTransactionCount() {
    return null;
  }

  getChangeAddress(server: WalletService, wallet, opts) {
    return new Promise((resolve, reject) => {
      const getChangeAddress = (wallet, cb) => {
        if (wallet.singleAddress) {
          server.storage.fetchAddresses(server.walletId, (err, addresses) => {
            if (err) return cb(err);
            if (_.isEmpty(addresses)) return cb(new ClientError('The wallet has no addresses'));
            return cb(null, _.head(addresses));
          });
        } else {
          if (opts.changeAddress) {
            try {
              this.validateAddress(wallet, opts.changeAddress, opts);
            } catch (addrErr) {
              return cb(addrErr);
            }

            server.storage.fetchAddressByWalletId(wallet.id, opts.changeAddress, (err, address) => {
              if (err || !address) return cb(Errors.INVALID_CHANGE_ADDRESS);
              return cb(null, address);
            });
          } else {
            const escrowInputs = opts.instantAcceptanceEscrow ? opts.inputs : undefined;
            return cb(null, wallet.createAddress(true, undefined, escrowInputs), true);
          }
        }
      };

      getChangeAddress(wallet, (err, address, isNew) => {
        if (err) return reject(err);
        return resolve(address);
      });
    });
  }

  checkDust(output) {
    const dustThreshold = Math.max(Defaults.MIN_OUTPUT_AMOUNT, this.bitcoreLib.Transaction.DUST_AMOUNT);

    if (output.amount < dustThreshold) {
      return Errors.DUST_AMOUNT;
    }
  }

  checkScriptOutput(output) {
    if (output.script) {
      if (typeof output.script !== 'string') {
        return Errors.SCRIPT_TYPE;
      }

      // check OP_RETURN
      if (!output.script.startsWith('6a')) {
        return Errors.SCRIPT_OP_RETURN;
      }

      // check OP_RETURN amount
      if (output.script.startsWith('6a') && output.amount != 0) {
        return Errors.SCRIPT_OP_RETURN_AMOUNT;
      }
    }
  }

  // https://bitcoin.stackexchange.com/questions/88226/how-to-calculate-the-size-of-multisig-transaction
  getEstimatedSizeForSingleInput(txp, opts = { conservativeEstimation: false }) {
    const SIGNATURE_SIZE = 72 + 1; // 73 is for non standanrd, not our wallet. +1 OP_DATA
    const PUBKEY_SIZE = 33 + 1; // +1 OP_DATA
    const inputSafetyMargin = this.getInputSizeSafetyMargin({ conservativeEstimation: opts.conservativeEstimation });

    switch (txp.addressType) {
      case Constants.SCRIPT_TYPES.P2PKH:
        // https://bitcoin.stackexchange.com/questions/48279/how-big-is-the-input-of-a-p2pkh-transaction
        return 148 + inputSafetyMargin;

      case Constants.SCRIPT_TYPES.P2WPKH:
        return 69 + inputSafetyMargin; // vsize

      case Constants.SCRIPT_TYPES.P2TR:
        return 58 + inputSafetyMargin; // vsize

      case Constants.SCRIPT_TYPES.P2WSH:
        return Math.ceil(32 + 4 + 1 + (5 + txp.requiredSignatures * 74 + txp.walletN * 34) / 4 + 4) + inputSafetyMargin; // vsize

      case Constants.SCRIPT_TYPES.P2SH:
        return 46 + txp.requiredSignatures * SIGNATURE_SIZE + txp.walletN * PUBKEY_SIZE + inputSafetyMargin;

      default:
        logger.warn('Unknown address type at getEstimatedSizeForSingleInput: %o', txp.addressType);
        return 46 + txp.requiredSignatures * SIGNATURE_SIZE + txp.walletN * PUBKEY_SIZE + inputSafetyMargin;
    }
  }

  // Data from:
  // https://bitcoin.stackexchange.com/questions/88226/how-to-calculate-the-size-of-multisig-transaction
  getEstimatedSizeForSingleOutput(address?: string) {
    let addressType = '';
    if (address) {
      const a = this.bitcoreLib.Address(address);
      addressType = a.type;
    }
    return this.getEstimatedSizeForAddressType(addressType);
  }

  getEstimatedSizeForAddressType(addressType?: string) {
    let scriptSize;
    switch (addressType) {
      case 'pubkeyhash':
        scriptSize = 25;
        break;
      case 'scripthash':
        scriptSize = 23;
        break;
      case 'witnesspubkeyhash':
        scriptSize = 22;
        break;
      case 'witnessscripthash':
        scriptSize = 34;
        break;
      default:
        scriptSize = 34;
        // logger.warn('Unknown address type at getEstimatedSizeForSingleOutput: %o', addressType);
        break;
    }
    return scriptSize + 8 + 1; // value + script length
  }

  getEstimatedSize(txp, opts) {
    const overhead = 4 + 4 + 1 + 1; // version, locktime, ninputs, noutputs
    // This assumed ALL inputs of the wallet are the same time
    const inputSize = this.getEstimatedSizeForSingleInput(txp, opts);
    const nbInputs = txp.inputs.length;
    let outputsSize = 0;
    let outputs = _.isArray(txp.outputs) ? txp.outputs : [txp.toAddress];
    let addresses = outputs.map(x => x.toAddress);
    if (txp.changeAddress) {
      addresses.push(txp.changeAddress.address);
    }
    _.each(addresses, x => {
      outputsSize += this.getEstimatedSizeForSingleOutput(x);
    });

    if (opts && opts.instantAcceptanceEscrow) {
      outputsSize += this.getEstimatedSizeForAddressType('scripthash');
    }

    // If there is no *output* yet defined, (eg: get sendmax info), add a single, default, output);
    if (!outputsSize) {
      outputsSize = this.getEstimatedSizeForSingleOutput();
    }

    const size = overhead + inputSize * nbInputs + outputsSize;
    return Math.ceil(size * 1 + this.getSizeSafetyMargin(opts));
  }

  getEstimatedFee(txp, opts) {
    $.checkState(_.isNumber(txp.feePerKb), 'Failed state: txp.feePerKb is not a number at <getEstimatedFee()>');
    let fee;

    // if TX is ready? no estimation is needed.
    if (txp.inputs.length && !txp.changeAddress && txp.outputs.length) {
      const totalInputs = _.sumBy(txp.inputs, 'satoshis');
      const totalOutputs = _.sumBy(txp.outputs, 'amount');
      if (totalInputs && totalOutputs) {
        fee = totalInputs - totalOutputs;
      }
    }

    if (!fee) {
      fee = (txp.feePerKb * this.getEstimatedSize(txp, opts)) / 1000;
      fee = Math.max(fee, this.bitcoreLib.Transaction.DUST_AMOUNT);
    }
    return parseInt(fee.toFixed(0));
  }

  getFee(server: WalletService, wallet, opts) {
    return new Promise(resolve => {
      server._getFeePerKb(wallet, opts, (err, feePerKb) => {
        return resolve({ feePerKb });
      });
    });
  }

  getBitcoreTx(txp, opts = { signed: true }) {
    const t = new this.bitcoreLib.Transaction();

    // BTC tx version
    if (txp.version <= 3) {
      t.setVersion(1);
    } else {
      t.setVersion(2);

      // set nLockTime (only txp.version>=4)
      if (txp.lockUntilBlockHeight) t.lockUntilBlockHeight(txp.lockUntilBlockHeight);
    }
    if (txp.multiTx) {
      throw Errors.MULTI_TX_UNSUPPORTED;
    }
    /*
     * txp.inputs clean txp.input
     * removes possible nSequence number (BIP68)
     */
    let inputs = txp.inputs.map(x => {
      return {
        address: x.address,
        txid: x.txid,
        vout: x.vout,
        outputIndex: x.outputIndex,
        scriptPubKey: x.scriptPubKey,
        satoshis: x.satoshis,
        publicKeys: x.publicKeys
      };
    });

    switch (txp.addressType) {
      case Constants.SCRIPT_TYPES.P2WSH:
      case Constants.SCRIPT_TYPES.P2SH:
        for (const i of inputs) {
          $.checkState(i.publicKeys, 'Failed state: Inputs should include public keys at <getBitcoreTx()>');
          t.from(i, i.publicKeys, txp.requiredSignatures);
        }
        break;
      case Constants.SCRIPT_TYPES.P2WPKH:
      case Constants.SCRIPT_TYPES.P2PKH:
      case Constants.SCRIPT_TYPES.P2TR:
        t.from(inputs);
        break;
    }

    for (const o of txp.outputs || []) {
      $.checkState(
        o.script || o.toAddress,
        'Failed state: Output should have either toAddress or script specified at <getBitcoreTx()>'
      );
      if (o.script) {
        t.addOutput(
          new this.bitcoreLib.Transaction.Output({
            script: o.script,
            satoshis: o.amount
          })
        );
      } else {
        t.to(o.toAddress, o.amount);
      }
    }

    t.fee(txp.fee);

    if (txp.instantAcceptanceEscrow && txp.escrowAddress) {
      t.escrow(txp.escrowAddress.address, txp.instantAcceptanceEscrow + txp.fee);
    }

    if (txp.enableRBF) t.enableRBF();

    if (txp.changeAddress) {
      t.change(txp.changeAddress.address);
    }

    // Shuffle outputs for improved privacy
    if (t.outputs.length > 1) {
      const outputOrder = _.reject(txp.outputOrder, (order: number) => {
        return order >= t.outputs.length;
      });
      $.checkState(
        t.outputs.length == outputOrder.length,
        'Failed state: t.outputs.length not equal to outputOrder.length at <getBitcoreTx()>'
      );
      t.sortOutputs(outputs => {
        return _.map(outputOrder, i => {
          return outputs[i];
        });
      });
    }

    // Validate actual inputs vs outputs independently of Bitcore
    const totalInputs = _.sumBy(t.inputs, 'output.satoshis');
    const totalOutputs = _.sumBy(t.outputs, 'satoshis');

    $.checkState(
      totalInputs > 0 && totalOutputs > 0 && totalInputs >= totalOutputs,
      'Failed state: not-enough-inputs at <getBitcoreTx()>'
    );
    $.checkState(
      totalInputs - totalOutputs <= Defaults.MAX_TX_FEE[txp.coin],
      'Failed state: fee-too-high at <getBitcoreTx()>'
    );

    if (opts.signed) {
      const sigs = txp.getCurrentSignatures();
      _.each(sigs, x => {
        this.addSignaturesToBitcoreTx(t, txp.inputs, txp.inputPaths, x.signatures, x.xpub, txp.signingMethod);
      });
    }
    return t;
  }

  convertFeePerKb(p, feePerKb) {
    return [p, Utils.strip(feePerKb * 1e8)];
  }

  checkTx(txp) {
    let bitcoreError;
    const MAX_TX_SIZE_IN_KB = Defaults.MAX_TX_SIZE_IN_KB_BTC;

    if (this.getEstimatedSize(txp, { conservativeEstimation: true }) / 1000 > MAX_TX_SIZE_IN_KB)
      return Errors.TX_MAX_SIZE_EXCEEDED;

    const serializationOpts = {
      disableIsFullySigned: true,
      disableSmallFees: true,
      disableLargeFees: true,
      disableDustOutputs: false
    };

    if (txp.outputs && Array.isArray(txp.outputs)) {
      for (let output of txp.outputs) {
        if (output.script && output.script.startsWith('6a')) { // check OP_RETURN
          serializationOpts.disableDustOutputs = true;
        }
      }
    }

    if (_.isEmpty(txp.inputPaths)) return Errors.NO_INPUT_PATHS;

    try {
      const bitcoreTx = this.getBitcoreTx(txp);
      bitcoreError = bitcoreTx.getSerializationError(serializationOpts);
      if (!bitcoreError) {
        txp.fee = bitcoreTx.getFee();
      }
    } catch (ex) {
      logger.warn('Error building Bitcore transaction: %o', ex);
      return ex;
    }

    if (bitcoreError instanceof this.bitcoreLib.errors.Transaction.FeeError) {
      return new ClientError(
        Errors.codes.INSUFFICIENT_FUNDS_FOR_FEE,
        `${Errors.INSUFFICIENT_FUNDS_FOR_FEE.message}. RequiredFee: ${txp.fee} Coin: ${txp.coin} feePerKb: ${txp.feePerKb} Err1`,
        {
          coin: txp.coin,
          feePerKb: txp.feePerKb,
          requiredFee: txp.fee
        }
      );
    }
    if (bitcoreError instanceof this.bitcoreLib.errors.Transaction.DustOutputs) return Errors.DUST_AMOUNT;
    return bitcoreError;
  }

  checkTxUTXOs(server: WalletService, txp, opts, cb) {
    logger.debug('Rechecking UTXOs availability for publishTx');

    if (txp.replaceTxByFee) {
      logger.debug('Ignoring spend utxos check (Replacing tx designated as RBF)');
      return cb();
    }

    const utxoKey = utxo => {
      return utxo.txid + '|' + utxo.vout;
    };

    server.getUtxosForCurrentWallet(
      {
        addresses: txp.inputs
      },
      (err, utxos) => {
        if (err) return cb(err);

        const txpInputs = _.map(txp.inputs, utxoKey);
        const utxosIndex = _.keyBy(utxos, utxoKey);
        const unavailable = _.some(txpInputs, i => {
          const utxo = utxosIndex[i];
          return !utxo || utxo.locked;
        });

        if (unavailable) return cb(Errors.UNAVAILABLE_UTXOS);
        return cb();
      }
    );
  }

  totalizeUtxos(utxos) {
    const balance = {
      totalAmount: _.sumBy(utxos, 'satoshis'),
      lockedAmount: _.sumBy(_.filter(utxos, 'locked'), 'satoshis'),
      totalConfirmedAmount: _.sumBy(_.filter(utxos, 'confirmations'), 'satoshis'),
      lockedConfirmedAmount: _.sumBy(_.filter(_.filter(utxos, 'locked'), 'confirmations'), 'satoshis'),
      availableAmount: undefined,
      availableConfirmedAmount: undefined
    };
    balance.availableAmount = balance.totalAmount - balance.lockedAmount;
    balance.availableConfirmedAmount = balance.totalConfirmedAmount - balance.lockedConfirmedAmount;

    return balance;
  }

  selectTxInputs(server: WalletService, txp, wallet, opts, cb) {
    const MAX_TX_SIZE_IN_KB = Defaults.MAX_TX_SIZE_IN_KB_BTC;

    // todo: check inputs are ours and have enough value
    if (txp.inputs && !_.isEmpty(txp.inputs) && !txp.replaceTxByFee) {
      if (!_.isNumber(txp.fee)) txp.fee = this.getEstimatedFee(txp, { conservativeEstimation: true });
      return cb(this.checkTx(txp));
    }

    const feeOpts = {
      conservativeEstimation: opts.payProUrl ? true : false,
      instantAcceptanceEscrow: opts.instantAcceptanceEscrow
    };
    const escrowAmount = opts.instantAcceptanceEscrow || 0;
    const txpAmount = txp.getTotalAmount() + escrowAmount;
    const baseTxpSize = this.getEstimatedSize(txp, feeOpts);
    const baseTxpFee = (baseTxpSize * txp.feePerKb) / 1000;
    const sizePerInput = this.getEstimatedSizeForSingleInput(txp, feeOpts);
    const feePerInput = (sizePerInput * txp.feePerKb) / 1000;

    logger.debug(
      `Amount ${Utils.formatAmountInBtc(
        txpAmount
      )} baseSize ${baseTxpSize} baseTxpFee ${baseTxpFee} sizePerInput ${sizePerInput}  feePerInput ${feePerInput}`
    );

    const sanitizeUtxos = utxos => {
      const excludeIndex = _.reduce(
        opts.utxosToExclude,
        (res, val) => {
          res[val] = val;
          return res;
        },
        {}
      );

      return _.filter(utxos, utxo => {
        if (utxo.locked) return false;
        if (txp.excludeUnconfirmedUtxos && !txp.replaceTxByFee && !utxo.confirmations) return false;
        if (excludeIndex[utxo.txid + ':' + utxo.vout]) return false;
        return true;
      });
    };

    const select = (utxos, requiredInputs, cb) => {
      let requiredTxids = [];
      if (requiredInputs.length > 0 && txp.replaceTxByFee) { 
        requiredTxids = _.map(requiredInputs, 'txid');
      }
      let totalValueInUtxos = _.sumBy(utxos, 'satoshis');
      if (totalValueInUtxos < txpAmount) {
        logger.debug(
          'Total value in all utxos (' +
            Utils.formatAmountInBtc(totalValueInUtxos) +
            ') is insufficient to cover for txp amount (' +
            Utils.formatAmountInBtc(txpAmount) +
            ')'
        );
        return cb(Errors.INSUFFICIENT_FUNDS);
      }

      // remove utxos not economically worth to send
      utxos = _.filter(utxos, utxo => {
        if (requiredTxids.includes(utxo.txid)) return true;
        if (utxo.satoshis <= feePerInput) return false;
        return true;
      });

      totalValueInUtxos = _.sumBy(utxos, 'satoshis');

      const netValueInUtxos = totalValueInUtxos - (baseTxpFee - utxos.length * feePerInput);

      if (netValueInUtxos < txpAmount) {
        logger.debug(
          'Value after fees in all utxos (' +
            Utils.formatAmountInBtc(netValueInUtxos) +
            ') is insufficient to cover for txp amount (' +
            Utils.formatAmountInBtc(txpAmount) +
            ')'
        );

        return cb(
          new ClientError(
            Errors.codes.INSUFFICIENT_FUNDS_FOR_FEE,
            `${Errors.INSUFFICIENT_FUNDS_FOR_FEE.message}. RequiredFee: ${baseTxpFee} Coin: ${txp.coin} feePerKb: ${txp.feePerKb} Err2`,
            {
              coin: txp.coin,
              feePerKb: txp.feePerKb,
              requiredFee: baseTxpFee
            }
          )
        );
      }

      const bigInputThreshold = txpAmount * Defaults.UTXO_SELECTION_MAX_SINGLE_UTXO_FACTOR + (baseTxpFee + feePerInput);
      logger.debug('Big input threshold ' + Utils.formatAmountInBtc(bigInputThreshold));

      const partitions = _.partition(utxos, utxo => {
        return utxo.satoshis > bigInputThreshold;
      });


      const bigInputs = _.sortBy(partitions[0], [
        utxo => !requiredTxids.includes(utxo.txid),
        'satoshis'
      ]);
      const smallInputs = _.sortBy(partitions[1], [
        utxo => !requiredTxids.includes(utxo.txid),
        utxo => -utxo.satoshis
      ]);

      logger.debug('Considering ' + bigInputs.length + ' big inputs (' + Utils.formatUtxos(bigInputs) + ')');
      logger.debug('Considering ' + smallInputs.length + ' small inputs (' + Utils.formatUtxos(smallInputs) + ')');

      let total = 0;
      let netTotal = -baseTxpFee;
      let selected = [];
      let fullTxpAmount = txpAmount;
      let fee;
      let error;

      _.each(smallInputs, (input, i) => {
        logger.debug('Input #' + i + ': ' + Utils.formatUtxos(input));

        const netInputAmount = input.satoshis - feePerInput;

        logger.debug('The input contributes ' + Utils.formatAmountInBtc(netInputAmount));

        selected.push(input);

        total += input.satoshis;
        netTotal += netInputAmount;

        const txpSize = baseTxpSize + selected.length * sizePerInput;
        fee = Math.round(baseTxpFee + selected.length * feePerInput);

        // The escrow address must contain the instantAcceptanceEscrow satoshis specified
        // by the merchant plus the miner fee on the ZCE-secured payment.
        // Rationale: https://github.com/bitjson/bch-zce#zce-extension-to-json-payment-protocol
        fullTxpAmount = escrowAmount ? txpAmount + fee : txpAmount;

        logger.debug('Tx size: ' + Utils.formatSize(txpSize) + ', Tx fee: ' + Utils.formatAmountInBtc(fee));

        const feeVsAmountRatio = fee / fullTxpAmount;
        const amountVsUtxoRatio = netInputAmount / fullTxpAmount;

        // logger.debug('Fee/Tx amount: ' + Utils.formatRatio(feeVsAmountRatio) + ' (max: ' + Utils.formatRatio(Defaults.UTXO_SELECTION_MAX_FEE_VS_TX_AMOUNT_FACTOR) + ')');
        // logger.debug('Tx amount/Input amount:' + Utils.formatRatio(amountVsUtxoRatio) + ' (min: ' + Utils.formatRatio(Defaults.UTXO_SELECTION_MIN_TX_AMOUNT_VS_UTXO_FACTOR) + ')');

        if (txpSize / 1000 > MAX_TX_SIZE_IN_KB) {
          //          logger.debug('Breaking because tx size (' + Utils.formatSize(txpSize) + ') is too big (max: ' + Utils.formatSize(this.MAX_TX_SIZE_IN_KB * 1000.) + ')');
          error = Errors.TX_MAX_SIZE_EXCEEDED;
          return false;
        }

        if (!_.isEmpty(bigInputs)) {
          if (amountVsUtxoRatio < Defaults.UTXO_SELECTION_MIN_TX_AMOUNT_VS_UTXO_FACTOR) {
            // logger.debug('Breaking because utxo is too small compared to tx amount');
            return false;
          }

          if (feeVsAmountRatio > Defaults.UTXO_SELECTION_MAX_FEE_VS_TX_AMOUNT_FACTOR) {
            const feeVsSingleInputFeeRatio = fee / (baseTxpFee + feePerInput);
            // logger.debug('Fee/Single-input fee: ' + Utils.formatRatio(feeVsSingleInputFeeRatio) + ' (max: ' + Utils.formatRatio(Defaults.UTXO_SELECTION_MAX_FEE_VS_SINGLE_UTXO_FEE_FACTOR) + ')' + ' loses wrt single-input tx: ' + Utils.formatAmountInBtc((selected.length - 1) * feePerInput));
            if (feeVsSingleInputFeeRatio > Defaults.UTXO_SELECTION_MAX_FEE_VS_SINGLE_UTXO_FEE_FACTOR) {
              // logger.debug('Breaking because fee is too significant compared to tx amount and it is too expensive compared to using single input');
              return false;
            }
          }
        }

        logger.debug(
          'Cumuled total so far: ' +
            Utils.formatAmountInBtc(total) +
            ', Net total so far: ' +
            Utils.formatAmountInBtc(netTotal)
        );

        if (netTotal >= fullTxpAmount) {
          const changeAmount = Math.round(total - fullTxpAmount - fee);
          logger.debug('Tx change: %o', Utils.formatAmountInBtc(changeAmount));

          const dustThreshold = Math.max(Defaults.MIN_OUTPUT_AMOUNT, this.bitcoreLib.Transaction.DUST_AMOUNT);
          if (changeAmount > 0 && changeAmount <= dustThreshold) {
            logger.debug(
              'Change below dust threshold (' +
                Utils.formatAmountInBtc(dustThreshold) +
                '). Incrementing fee to remove change.'
            );
            // Remove dust change by incrementing fee
            fee += changeAmount;
          }

          return false;
        }
      });

      if (netTotal < fullTxpAmount) {
        logger.debug(
          'Could not reach Txp total (' +
            Utils.formatAmountInBtc(fullTxpAmount) +
            '), still missing: ' +
            Utils.formatAmountInBtc(fullTxpAmount - netTotal)
        );

        selected = [];
        if (!_.isEmpty(bigInputs)) {
          const input = _.head(bigInputs);
          logger.debug('Using big input: %o', Utils.formatUtxos(input));
          total = input.satoshis;
          fee = Math.round(baseTxpFee + feePerInput);
          netTotal = total - fee;
          selected = [input];
        }
      }

      if (_.isEmpty(selected)) {
        // logger.debug('Could not find enough funds within this utxo subset');
        return cb(
          error ||
            new ClientError(
              Errors.codes.INSUFFICIENT_FUNDS_FOR_FEE,
              `${Errors.INSUFFICIENT_FUNDS_FOR_FEE.message}. RequiredFee: ${fee} Coin: ${txp.coin} feePerKb: ${txp.feePerKb} Err3`,
              {
                coin: txp.coin,
                feePerKb: txp.feePerKb,
                requiredFee: fee
              }
            )
        );
      }

      return cb(null, selected, fee);
    };

    // logger.debug('Selecting inputs for a ' + Utils.formatAmountInBtc(txp.getTotalAmount()) + ' txp');

    server.getUtxosForCurrentWallet(
      {
        instantAcceptanceEscrow: txp.instantAcceptanceEscrow,
        replaceTxByFee: txp.replaceTxByFee,
        inputs: txp.inputs
      },
      (err, utxos) => {
        if (err) return cb(err);

        let totalAmount;
        let availableAmount;

        const balance = this.totalizeUtxos(utxos);
        if (txp.excludeUnconfirmedUtxos && !txp.replaceTxByFee) {
          totalAmount = balance.totalConfirmedAmount;
          availableAmount = balance.availableConfirmedAmount;
        } else {
          totalAmount = balance.totalAmount;
          availableAmount = balance.availableAmount;
        }

        if (totalAmount < txp.getTotalAmount()) return cb(Errors.INSUFFICIENT_FUNDS);
        if (availableAmount < txp.getTotalAmount()) return cb(Errors.LOCKED_FUNDS);

        utxos = sanitizeUtxos(utxos);

        // logger.debug('Considering ' + utxos.length + ' utxos (' + Utils.formatUtxos(utxos) + ')');

        const groups = [6, 1];
        if (!txp.excludeUnconfirmedUtxos) groups.push(0);

        let inputs = [];
        let fee;
        let selectionError;
        let i = 0;
        let lastGroupLength;
        async.whilst(
          () => {
            return i < groups.length && _.isEmpty(inputs);
          },
          next => {
            const group = groups[i++];

            let candidateUtxos = _.filter(utxos, utxo => {
              return utxo.confirmations >= group;
            });

            if (opts.instantAcceptanceEscrow && wallet.isZceCompatible()) {
              const utxosSortedByDescendingAmount = candidateUtxos.sort((a, b) => b.amount - a.amount);
              const utxosWithUniqueAddresses = _.uniqBy(utxosSortedByDescendingAmount, 'address');
              candidateUtxos = utxosWithUniqueAddresses;
            }

            if (txp.replaceTxByFee) {
              // make sure we are using at least one input from the transaction that we are replacing
              const txIdArray: any[] = _.map(opts.inputs, 'txid');
              candidateUtxos = candidateUtxos.sort((a, b) => {
                return txIdArray.indexOf(b.txid) - txIdArray.indexOf(a.txid);
              });
            }

            // logger.debug('Group >= ' + group);

            // If this group does not have any new elements, skip it
            if (lastGroupLength === candidateUtxos.length) {
              // logger.debug('This group is identical to the one already explored');
              return next();
            }

            // logger.debug('Candidate utxos: ' + Utils.formatUtxos(candidateUtxos));

            lastGroupLength = candidateUtxos.length;

            select(candidateUtxos, txp.inputs, (err, selectedInputs, selectedFee) => {
              if (err) {
                // logger.debug('No inputs selected on this group: ', err);
                selectionError = err;
                return next();
              }

              selectionError = null;
              inputs = selectedInputs;
              fee = selectedFee;

              logger.debug('Selected inputs from this group: ' + Utils.formatUtxos(inputs));
              logger.debug('Fee for this selection: ' + Utils.formatAmountInBtc(fee));

              return next();
            });
          },
          err => {
            if (err) return cb(err);
            if (selectionError || _.isEmpty(inputs))
              return cb(selectionError || new Error('Could not select tx inputs'));

            txp.setInputs(_.shuffle(inputs));
            txp.fee = fee;

            err = this.checkTx(txp);
            if (!err) {
              const change = _.sumBy(txp.inputs, 'satoshis') - _.sumBy(txp.outputs, 'amount') - txp.fee;
              logger.debug(
                'Successfully built transaction. Total fees: ' +
                  Utils.formatAmountInBtc(txp.fee) +
                  ', total change: ' +
                  Utils.formatAmountInBtc(change)
              );
            } else {
              logger.warn('Error building transaction: %o', err);
            }

            return cb(err);
          }
        );
      }
    );
  }

  checkUtxos(opts) {
    if (_.isNumber(opts.fee) && _.isEmpty(opts.inputs)) return true;
  }

  checkValidTxAmount(output): boolean {
    if (!_.isNumber(output.amount) || _.isNaN(output.amount) || output.amount <= 0) {
      return false;
    }
    return true;
  }

  supportsMultisig() {
    return true;
  }

  notifyConfirmations(network: string) {
    if (network != 'livenet') return false;

    return true;
  }

  isUTXOChain() {
    return true;
  }
  isSingleAddress() {
    return false;
  }

  addressFromStorageTransform(network, address) {}

  addressToStorageTransform(network, address) {}

  addSignaturesToBitcoreTx(tx, inputs, inputPaths, signatures, xpub, signingMethod) {
    signingMethod = signingMethod || 'ecdsa';
    if (signatures.length != inputs.length) throw new Error('Number of signatures does not match number of inputs');

    let i = 0;
    const x = new this.bitcoreLib.HDPublicKey(xpub);

    for (const signatureHex of signatures) {
      try {
        const signature = this.bitcoreLib.crypto.Signature.fromString(signatureHex);
        const pub = x.deriveChild(inputPaths[i]).publicKey;
        // tslint:disable-next-line:no-bitwise
        const SIGHASH_TYPE = this.bitcoreLib.crypto.Signature.SIGHASH_ALL | this.bitcoreLib.crypto.Signature.SIGHASH_FORKID;
        const s = {
          inputIndex: i,
          signature,
          sigtype: SIGHASH_TYPE,
          publicKey: pub
        };
        tx.inputs[i].addSignature(tx, s, signingMethod);
        i++;
      } catch (e) {}
    }

    if (i != tx.inputs.length) throw new Error('Wrong signatures');
  }

  validateAddress(wallet, inaddr, opts) {
    const A = this.bitcoreLib.Address;
    let addr: {
      network?: string;
      toString?: (cashAddr: boolean) => string;
    } = {};
    try {
      addr = new A(inaddr);
    } catch (ex) {
      throw Errors.INVALID_ADDRESS;
    }
    if (!this._isCorrectNetwork(wallet, addr)) {
      throw Errors.INCORRECT_ADDRESS_NETWORK;
    }
    return;
  }

  protected _isCorrectNetwork(wallet, addr) {
    const addrNetwork = Utils.getNetworkName(wallet.chain, addr.network.toString())
    const walNetwork = wallet.network;
    if (Utils.getNetworkType(addrNetwork) === 'testnet' && walNetwork === 'regtest') {
      return !!config.allowRegtest;
    }
    return addrNetwork === walNetwork;
  }

  // Push notification handling
  onCoin(coin) {
    // script output, or similar.
    if (!coin || !coin.address) return;

    return {
      out: {
        address: coin.address,
        amount: coin.value
      },
      txid: coin.mintTxid
    };
  }

  // Push notification handling
  onTx(tx) {
    return null;
  }

  getReserve(server: WalletService, wallet: IWallet, cb: (err?, reserve?: number) => void) {
    return cb(null, 0);
  }

  refreshTxData(_server: WalletService, txp, _opts, cb) {
    return cb(null, txp);
  }
}
