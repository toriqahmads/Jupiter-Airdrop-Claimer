import { utils, Program, getProvider, AnchorProvider, Wallet, BN } from "@project-serum/anchor";
import { Connection, Keypair, ParsedAccountData, PublicKey, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createTransferInstruction, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, transferInstructionData } from "@solana/spl-token";

import { PRIVATE_KEY, PROGRAM_ID, SOLANA_RPC, TOKEN_ID, TRANSFER_TO } from "./constants";
import { IDL } from "./idl";
import invariant from "tiny-invariant";
import axios from "axios";
import bs58 from 'bs58';

const SOLANA_CONNECTION = new Connection(SOLANA_RPC, "confirmed");

export const getClaimInfo = async(address: string) => {
  const info = await axios.get(`https://worker.jup.ag/jup-claim-proof/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/${address}`);
  return info.data;
}

export const toBytes32Array = (b: Buffer): number[] => {
  invariant(b.length <= 32, `invalid length ${b.length}`);
  const buf = Buffer.alloc(32);
  b.copy(buf, 32 - b.length);

  return Array.from(buf);
};

export const findDistributorKey = async (): Promise<[PublicKey, number]> => {
  return PublicKey.findProgramAddressSync(
    [utils.bytes.utf8.encode("MerkleDistributor"), TOKEN_ID.toBytes()],
    PROGRAM_ID
  );
};

export const findClaimStatusKey = async (
  claimant: PublicKey,
  distributor: PublicKey,
): Promise<[PublicKey, number]> => {
  return PublicKey.findProgramAddressSync(
    [
      utils.bytes.utf8.encode("ClaimStatus"),
      claimant.toBytes(),
      distributor.toBytes(),
    ],
    PROGRAM_ID
  );
};

export const getWallet = (private_key: string): Keypair => {
  const secret = bs58.decode(private_key);
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

export const getNumberDecimals = async (token_address: PublicKey): Promise<number>  => {
  const info = await SOLANA_CONNECTION.getParsedAccountInfo(token_address);
  const result = (info.value?.data as ParsedAccountData).parsed.info.decimals as number;
  return result;
}

export const getATA = async (token_address: PublicKey, owner: PublicKey) => {
  return await getAssociatedTokenAddress(
    token_address,
    owner
  );
}

export const getOrCreateATA = async (token_address: PublicKey, payer: Keypair, owner: PublicKey) => {
  return await getOrCreateAssociatedTokenAccount(
    SOLANA_CONNECTION,
    payer,
    token_address,
    owner
  );
}

export const createATAInstruction = async (token_address: PublicKey, owner: PublicKey, ata: PublicKey, payer: PublicKey) => {
  return createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    token_address,
    PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export const createTransferTokenInstruction = async (token_address: PublicKey, ataSource: PublicKey, ataDestination: PublicKey, owner: PublicKey, amount: number) => {
  // const decimal = await getNumberDecimals(token_address);

  return createTransferInstruction(
    ataSource,
    ataDestination,
    owner,
    amount
  );
}

export const createClaimInstruction = async (token_address: PublicKey, from: Keypair, claimInfo) => {
  const provider = new AnchorProvider(SOLANA_CONNECTION, new Wallet(from), { skipPreflight: true, commitment: 'confirmed' });
  const program = new Program(JSON.parse(JSON.stringify(IDL)), PROGRAM_ID, provider);

  const claimStatus = await findClaimStatusKey(from.publicKey, new PublicKey(claimInfo.merkle_tree));
  const destinationAccount = await getATA(token_address, from.publicKey);
  const distributorFrom = await getAssociatedTokenAddress(
    token_address,
    new PublicKey(claimInfo.merkle_tree),
    true,
  );

  const instruction = await program.methods.newClaim(
    new BN(claimInfo.amount),
    new BN(0),
    claimInfo.proof.map((p) => toBytes32Array(Buffer.from(p)))
  ).accounts({
    distributor: new PublicKey(claimInfo.merkle_tree),
    claimStatus: claimStatus[0],
    from: distributorFrom,
    to: destinationAccount,
    claimant: from.publicKey,
    tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    systemProgram: new PublicKey("11111111111111111111111111111111"),
  }).instruction();

  return instruction;
}

(async () => {
  const wallet = getWallet(PRIVATE_KEY);
  const claimInfo = await getClaimInfo(wallet.publicKey.toString());
  const ATASource = await getATA(TOKEN_ID, wallet.publicKey);
  const ATADestination = await getATA(TOKEN_ID, TRANSFER_TO);
  // const createAtaInstructionSource = await createATAInstruction(TOKEN_ID, wallet.publicKey, ATASource, wallet.publicKey);
  const createAtaInstructionDestination = await createATAInstruction(TOKEN_ID, TRANSFER_TO, ATADestination, wallet.publicKey);
  const claimInstruction = await createClaimInstruction(TOKEN_ID, wallet, claimInfo);
  const transferInstruction = await createTransferTokenInstruction(TOKEN_ID, ATASource, ATADestination, wallet.publicKey, claimInfo.amount);

  const transaction = new Transaction()
    // .add(createAtaInstructionSource)
    .add(createAtaInstructionDestination)
    .add(claimInstruction)
    .add(transferInstruction)

  while (true) {
    try {
      const tx = await SOLANA_CONNECTION.sendTransaction(transaction, [wallet]);
      console.log('tx', tx);
    } catch (err) {
      console.log(err.message);
    }
  }
})();
