/**
 * Integration test helpers for Stellar testnet operations and backend API calls.
 */
import { Keypair, TransactionBuilder, Networks, Asset, Operation, Account } from "@stellar/stellar-sdk";
import fetch from "node-fetch";

export const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";

/** Generate a new keypair and fund it via friendbot. */
export async function createTestAccount(): Promise<Keypair> {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();

  // Fund via friendbot with retry logic
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
      if (res.ok) {
        // Wait for ledger to settle
        await new Promise((r) => setTimeout(r, 1000));
        return keypair;
      }
      if (i === maxRetries - 1) {
        throw new Error(`Friendbot funding failed after ${maxRetries} attempts: ${res.statusText}`);
      }
    } catch (err) {
      if (i === maxRetries - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Failed to create and fund test account");
}

/** Load account data from Horizon. */
export async function loadHorizonAccount(publicKey: string) {
  const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (!res.ok) {
    throw new Error(`Horizon loadAccount failed: ${res.statusText}`);
  }
  return res.json();
}

/** Set up a trustline for an asset (e.g., USDC). */
export async function setupTrustline(keypair: Keypair, assetCode: string, assetIssuer: string): Promise<void> {
  // Load account to get sequence number
  const accountRes = await fetch(`${HORIZON_URL}/accounts/${keypair.publicKey()}`);
  const accountData = await accountRes.json();
  
  const asset = new Asset(assetCode, assetIssuer);
  const account = new Account(keypair.publicKey(), accountData.sequence);
  
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset, limit: "1000000" }))
    .setTimeout(30)
    .build();
  
  tx.sign(keypair);
  
  const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toXDR() }),
  });
  
  if (!submitRes.ok) {
    const errorText = await submitRes.text();
    throw new Error(`Trustline setup failed: ${errorText}`);
  }
}

/** Perform SEP-10 authentication and return a session token. */
export async function authenticateUser(keypair: Keypair): Promise<string> {
  const publicKey = keypair.publicKey();

  // Step 1: Request challenge
  const challengeRes = await fetch(`${API_BASE_URL}/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: publicKey }),
  });

  if (!challengeRes.ok) {
    throw new Error(`Challenge request failed: ${challengeRes.statusText}`);
  }

  const challengeData = await challengeRes.json();
  const { transaction, network_passphrase } = challengeData;

  // Step 2: Sign the challenge transaction
  const tx = TransactionBuilder.fromXDR(transaction, network_passphrase || Networks.TESTNET);
  tx.sign(keypair);
  const signedXdr = tx.toXDR();

  // Step 3: Submit signed challenge to get token
  const tokenRes = await fetch(`${API_BASE_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token request failed: ${tokenRes.statusText}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.token as string;
}

/** Create a group via the API. */
export async function createGroup(token: string, name: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API_BASE_URL}/groups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    throw new Error(`Create group failed: ${res.statusText}`);
  }

  return res.json();
}

/** Add a member to a group. */
export async function addMember(token: string, groupId: string, publicKey: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/groups/${groupId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ publicKey }),
  });

  if (!res.ok) {
    throw new Error(`Add member failed: ${res.statusText}`);
  }
}

/** Create an expense with split details. */
export async function createExpense(
  token: string,
  groupId: string,
  data: {
    description: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string;
    payerId: string;
    splitType: "equal" | "custom" | "percentage";
    shares: Array<{ userId: string; amount?: string; percent?: number }>;
  }
): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE_URL}/groups/${groupId}/expenses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    throw new Error(`Create expense failed: ${res.statusText}`);
  }

  return res.json();
}

/** Trigger settlement of an expense. */
export async function settleExpense(token: string, expenseId: string): Promise<{ transactionHash: string }> {
  const res = await fetch(`${API_BASE_URL}/expenses/${expenseId}/settle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Settle expense failed: ${res.statusText} - ${err}`);
  }

  return res.json();
}

/** Get expense details. */
export async function getExpense(token: string, expenseId: string) {
  const res = await fetch(`${API_BASE_URL}/expenses/${expenseId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Get expense failed: ${res.statusText}`);
  }

  return res.json();
}

/** Wait for a transaction to appear on Horizon with retries. */
export async function waitForTransaction(hash: string, maxRetries = 30): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${HORIZON_URL}/transactions/${hash}`);
      if (res.ok) {
        return res.json();
      }
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Transaction ${hash} not found on Horizon after ${maxRetries} retries`);
}
