import React, { useContext, useEffect, useMemo, useState } from 'react';
import * as bip32 from 'bip32';
import { Account } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  setInitialAccountInfo,
  useAccountInfo,
  useConnection,
} from './connection';
import {
  closeTokenAccount,
  createAndInitializeTokenAccount,
  getOwnedTokenAccounts,
  transferTokens,
  nativeTransfer,
} from './tokens';
import { TOKEN_PROGRAM_ID, WRAPPED_SOL_MINT } from './tokens/instructions';
import {
  ACCOUNT_LAYOUT,
  parseMintData,
  parseTokenAccountData,
} from './tokens/data';
import { useListener, useLocalStorageState } from './utils';
import { useTokenName } from './tokens/names';
import { refreshCache, useAsyncData } from './fetch-loop';
import { getUnlockedMnemonicAndSeed, walletSeedChanged, loadMnemonicAndSeed, lock } from './wallet-seed';
import { getPublicKey, solana_derivation_path, solana_ledger_sign_transaction } from './ledger';
import TransportWebUsb from "@ledgerhq/hw-transport-webusb";
import { useSnackbar } from 'notistack';

import { useCallAsync } from './notifications';

function getAccountFromSeed(seed, walletIndex, accountIndex = 0) {

  const derivedSeed = bip32
    .fromSeed(seed)
    .derivePath(`m/501'/${walletIndex}'/0/${accountIndex}`).privateKey;
  return new Account(nacl.sign.keyPair.fromSeed(derivedSeed).secretKey);
}

class LocalStorageWalletProvider {
  constructor(walletIndex) {
    const { seed } = getUnlockedMnemonicAndSeed();
    this.walletIndex = walletIndex;
    this.account = getAccountFromSeed(Buffer.from(seed, 'hex'), this.walletIndex)
  }

  init = async () => {
    return this;
  }

  get publicKey() {
    return this.account.publicKey;
  }

  signTransaction = async (transaction) => {
    transaction.partialSign(this.account);
    return transaction;
  }
}

 class LedgerWalletProvider {
  constructor(walletIndex) {
    this.walletIndex = walletIndex;
  }

  init = async () => {
    this.transport = await TransportWebUsb.create();
    this.pubKey = await getPublicKey(this.transport);
    return this;
  }

  get publicKey() {
    return this.pubKey;
  }

  signTransaction = async (transaction) => {
    const from_derivation_path = solana_derivation_path();
    const sig_bytes = await solana_ledger_sign_transaction(this.transport, from_derivation_path, transaction);
    transaction.addSignature(this.publicKey, sig_bytes);

    return transaction;
  }
 }

 class WalletProviderFactory {
   static getProvider(type, walletIndex) {
     if(type === 'local') {
       return new LocalStorageWalletProvider(walletIndex)
     }

     if(type === 'ledger') {
       return new LedgerWalletProvider(walletIndex);
     }
   }
 }

export class Wallet {
  constructor(connection, walletIndex = 0, type) {
    this.connection = connection;
    this.walletIndex = walletIndex;
    this.provider = WalletProviderFactory.getProvider(type, walletIndex)
  }

  static create = async (connection, walletIndex = 0, type) => {
    const instance = new Wallet(connection, walletIndex, type);
    await instance.provider.init();
    return instance;
  }

  get publicKey() {
    return this.provider.publicKey;
  }

  getTokenAccountInfo = async () => {
    let accounts = await getOwnedTokenAccounts(
      this.connection,
      this.publicKey,
    );
    return accounts.map(({ publicKey, accountInfo }) => {
      setInitialAccountInfo(this.connection, publicKey, accountInfo);
      return { publicKey, parsed: parseTokenAccountData(accountInfo.data) };
    });
  };

  createTokenAccount = async (tokenAddress) => {
    return await createAndInitializeTokenAccount({
      connection: this.connection,
      payer: this,
      mintPublicKey: tokenAddress,
      newAccount: new Account(),
    });
  };

  tokenAccountCost = async () => {
    return this.connection.getMinimumBalanceForRentExemption(
      ACCOUNT_LAYOUT.span,
    );
  };

  transferToken = async (source, destination, amount, decimals, memo = null) => {
    if (source.equals(this.publicKey)) {
      if (memo) {
        throw new Error('Memo not implemented');
      }
      return this.transferSol(destination, amount);
    }
    return await transferTokens({
      connection: this.connection,
      owner: this,
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount,
      memo,
    });
  };

  signTransaction = async (transaction) => {
    return this.provider.signTransaction(transaction);
  }

  transferSol = async (destination, amount) => {
    return nativeTransfer(this.connection, this, destination, amount);
  };

  closeTokenAccount = async (publicKey) => {
    return await closeTokenAccount({
      connection: this.connection,
      owner: this,
      sourcePublicKey: publicKey,
    });
  };
}

const WalletContext = React.createContext(null);

export function WalletProvider({ children }) {
  useListener(walletSeedChanged, 'change');
  const [walletType, setWalletType] = useState('');
  const connection = useConnection();
  const callAsync = useCallAsync();
  const [walletIndex, setWalletIndex] = useLocalStorageState('walletIndex', 0);
  const [wallet, setWallet] = useState();
  const { enqueueSnackbar } = useSnackbar();

  useEffect(() => {
    (async () => {
      if(walletType) {
        try {
          const instance = await Wallet.create(connection, walletIndex, walletType);
          setWallet(instance);
        } catch (er) {
          setWalletType('')
          enqueueSnackbar(`${er.message}`, {
            variant: 'error',
            autoHideDuration: 2500,
          });
        }
      } else {
        setWallet(undefined);
      }
    })();
  }, [enqueueSnackbar, walletType, connection, walletIndex]);

  const login = async (method, password, stayLoggedIn) => {
    if (method === 'ledger') {
      setWalletType(method);
    } else {
      callAsync(loadMnemonicAndSeed(password, stayLoggedIn), {
        progressMessage: 'Unlocking wallet...',
        successMessage: 'Wallet unlocked',
        onSuccess: async () => {
          setWalletType(method);
        }
      });
    }
  }

  const logout = async () => {
    lock();
    setWalletType('');    
  };

  return (
    <WalletContext.Provider
      value={{ wallet, walletIndex, setWalletIndex, login, logout }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext).wallet;
}

export function useWalletAuth() {
  const { login, logout } = useContext(WalletContext);
  return { login, logout };
}

export function useWalletPublicKeys() {
  let wallet = useWallet();
  let [tokenAccountInfo, loaded] = useAsyncData(
    wallet.getTokenAccountInfo,
    wallet.getTokenAccountInfo,
  );
  const getPublicKeys = () => [
    wallet.publicKey,
    ...(tokenAccountInfo
      ? tokenAccountInfo.map(({ publicKey }) => publicKey)
      : []),
  ];
  const serialized = getPublicKeys()
    .map((pubKey) => pubKey?.toBase58() || '')
    .toString();

  // Prevent users from re-rendering unless the list of public keys actually changes
  let publicKeys = useMemo(getPublicKeys, [serialized]);
  return [publicKeys, loaded];
}

export function useWalletTokenAccounts() {
  let wallet = useWallet();
  return useAsyncData(wallet.getTokenAccountInfo, wallet.getTokenAccountInfo);
}

export function refreshWalletPublicKeys(wallet) {
  refreshCache(wallet.getTokenAccountInfo);
}

export function useWalletAddressForMint(mint) {
  const [walletAccounts] = useWalletTokenAccounts();
  return useMemo(
    () =>
      mint
        ? walletAccounts
            ?.find((account) => account.parsed?.mint?.equals(mint))
            ?.publicKey.toBase58()
        : null,
    [walletAccounts, mint],
  );
}

export function useBalanceInfo(publicKey) {
  let [accountInfo, accountInfoLoaded] = useAccountInfo(publicKey);
  let { mint, owner, amount } = accountInfo?.owner.equals(TOKEN_PROGRAM_ID)
    ? parseTokenAccountData(accountInfo.data)
    : {};
  let [mintInfo, mintInfoLoaded] = useAccountInfo(mint);
  let { name, symbol } = useTokenName(mint);

  if (!accountInfoLoaded) {
    return null;
  }

  if (mint && mint.equals(WRAPPED_SOL_MINT)) {
    return {
      amount,
      decimals: 9,
      mint,
      owner,
      tokenName: 'Wrapped SOL',
      tokenSymbol: 'SOL',
      valid: true,
    };
  }

  if (mint && mintInfoLoaded) {
    try {
      let { decimals } = parseMintData(mintInfo.data);
      return {
        amount,
        decimals,
        mint,
        owner,
        tokenName: name,
        tokenSymbol: symbol,
        valid: true,
      };
    } catch (e) {
      return {
        amount,
        decimals: 0,
        mint,
        owner,
        tokenName: 'Invalid',
        tokenSymbol: 'INVALID',
        valid: false,
      };
    }
  }

  if (!mint) {
    return {
      amount: accountInfo?.lamports ?? 0,
      decimals: 9,
      mint: null,
      owner: publicKey,
      tokenName: 'SOL',
      tokenSymbol: 'SOL',
      valid: true,
    };
  }

  return null;
}

export function useWalletSelector() {
  // TODO: read accounts from ledger as well ....
  const { walletIndex, setWalletIndex, seed } = useContext(WalletContext);
  const [ walletCount, setWalletCount ] = useLocalStorageState('walletCount', 1);
  function selectWallet(walletIndex) {
    if (walletIndex >= walletCount) {
      setWalletCount(walletIndex + 1);
    }
    setWalletIndex(walletIndex);
  }
  const addresses = useMemo(() => {
    if (!seed) {
      return [];
    }
    const seedBuffer = Buffer.from(seed, 'hex');
    return [...Array(walletCount).keys()].map(
      (walletIndex) =>
        getAccountFromSeed(seedBuffer, walletIndex).publicKey,
    );
  }, [seed, walletCount]);
  return { addresses, walletIndex, setWalletIndex: selectWallet };
}

export async function mnemonicToSecretKey(mnemonic) {
  const { mnemonicToSeed } = await import('bip39');
  const rootSeed = Buffer.from(await mnemonicToSeed(mnemonic), 'hex');
  const derivedSeed = bip32.fromSeed(rootSeed).derivePath("m/501'/0'/0/0")
    .privateKey;
  return nacl.sign.keyPair.fromSeed(derivedSeed).secretKey;
}