import { customAlphabet } from "nanoid";

export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

/** 8-char invite code. */
export const inviteCode = customAlphabet(ALPHABET, 8);

/** 10-char settlement / treasury short code used inside the Stellar memo. */
export const shortCode = customAlphabet(ALPHABET, 10);
