/**
 * SEP-10 server signing keypair generator (local development utility).
 *
 * The SEP-10 service (src/services/sep10.ts) signs every challenge
 * transaction with a server-held keypair loaded from SEP10_SIGNING_SECRET.
 * This script mints a fresh, random Stellar keypair for that variable and
 * prints it in a form you can paste straight into your `.env` file:
 *
 *   npm run gen:sep10key
 *   # then copy the SEP10_SIGNING_SECRET=... line into .env
 *
 * Set-up instructions are printed after the keys so the workflow is
 * self-documenting (issue #399). Docs also live in README.md
 * (`SEP10_SIGNING_SECRET`) and docs/LOCAL_SETUP.md.
 *
 * Safety: the secret is written to stdout only — never commit it to git or
 * share it. A production deployment must use a dedicated keypair; rotate by
 * re-running this script and updating SEP10_SIGNING_SECRET (sessions minted
 * with the old key simply expire).
 */
import { Keypair } from "@stellar/stellar-sdk";

const kp = Keypair.random();

// eslint-disable-next-line no-console
console.log(`SEP10_SIGNING_SECRET=${kp.secret()}`);
// eslint-disable-next-line no-console
console.log(`# public key: ${kp.publicKey()}`);
// eslint-disable-next-line no-console
console.log(`#
# Next steps:
#   1. Copy the SEP10_SIGNING_SECRET=... line above into your .env file
#      (see docs/LOCAL_SETUP.md for a full walkthrough).
#   2. Keep the server keypair private: never commit it or ship it to clients.
#   3. Restart the dev server so src/services/sep10.ts picks up the new key.
#
# The public key is printed for reference only — e.g. to identify the signing
# account of challenge transactions on testnet explorers. SEP-10 only needs
# the secret in SEP10_SIGNING_SECRET.`);
