export function buildAssessment(address, summary, txs, provider) {
  const chainStats = summary.chain_stats ?? {};
  const mempoolStats = summary.mempool_stats ?? {};
  const funded = (chainStats.funded_txo_sum ?? 0) + (mempoolStats.funded_txo_sum ?? 0);
  const spent = (chainStats.spent_txo_sum ?? 0) + (mempoolStats.spent_txo_sum ?? 0);
  const txCount = (chainStats.tx_count ?? 0) + (mempoolStats.tx_count ?? 0);
  const spentOutputs = (chainStats.spent_txo_count ?? 0) + (mempoolStats.spent_txo_count ?? 0);
  const hasSpent = spentOutputs > 0;
  const isReused = spentOutputs > 0;

  const outputScriptType = inferOutputScriptType(address, txs);
  const spendProfile = inferSpendProfile(address, txs);
  const addressType = classifyAddressType(address, outputScriptType);
  const risk = classifyRisk(addressType, hasSpent, txCount, spendProfile);
  const firstExposedAt = findFirstSpendingTx(address, txs);

  return {
    address,
    provider,
    addressType,
    outputScriptType,
    spendProfile,
    txCount,
    txsAnalyzed: txs.length,
    funded,
    spent,
    balance: funded - spent,
    spentOutputs,
    hasSpent,
    isReused,
    firstExposedAt,
    risk,
  };
}

export function inferOutputScriptType(address, txs) {
  for (const tx of txs) {
    const match = tx.vout?.find((output) => output.scriptpubkey_address === address);
    if (match?.scriptpubkey_type) {
      return match.scriptpubkey_type;
    }
  }

  return null;
}

export function inferSpendProfile(address, txs) {
  const profile = {
    spendingTxCount: 0,
    wrappedSegwit: false,
    witnessScriptExposed: false,
    redeemScriptExposed: false,
    multisig: false,
    pubkeyMaterialExposed: false,
    scriptPathExposed: false,
    summary: "No spend-path details observed.",
  };

  for (const tx of txs) {
    for (const vin of tx.vin ?? []) {
      if (vin.prevout?.scriptpubkey_address !== address) {
        continue;
      }

      profile.spendingTxCount += 1;

      const redeemAsm = vin.inner_redeemscript_asm ?? "";
      const witnessAsm = vin.inner_witnessscript_asm ?? "";
      const scriptSigAsm = vin.scriptsig_asm ?? "";
      const witness = vin.witness ?? [];

      if (redeemAsm) {
        profile.redeemScriptExposed = true;
        profile.scriptPathExposed = true;
      }

      if (witnessAsm) {
        profile.witnessScriptExposed = true;
        profile.scriptPathExposed = true;
      }

      if (redeemAsm.startsWith("OP_0 ")) {
        profile.wrappedSegwit = true;
      }

      if (
        redeemAsm.includes("CHECKMULTISIG") ||
        witnessAsm.includes("CHECKMULTISIG")
      ) {
        profile.multisig = true;
      }

      if (
        scriptSigAsm.includes("OP_PUSHBYTES_33") ||
        scriptSigAsm.includes("OP_PUSHBYTES_65") ||
        witness.some((item) => item.length === 66 || item.length === 130)
      ) {
        profile.pubkeyMaterialExposed = true;
      }
    }
  }

  if (profile.spendingTxCount === 0) {
    return profile;
  }

  if (profile.multisig) {
    profile.summary = "Spent via a revealed multisig or custom witness script.";
    return profile;
  }

  if (profile.wrappedSegwit) {
    profile.summary = "Spent via wrapped SegWit with redeem script reveal.";
    return profile;
  }

  if (profile.witnessScriptExposed) {
    profile.summary = "Spent via witness script path with script details revealed.";
    return profile;
  }

  if (profile.redeemScriptExposed) {
    profile.summary = "Spent via redeem script path with script details revealed.";
    return profile;
  }

  if (profile.pubkeyMaterialExposed) {
    profile.summary = "Spend path included public-key material in scriptSig or witness.";
    return profile;
  }

  profile.summary = "Spent outputs were detected, but the spend path was not decoded beyond the previous output reference.";
  return profile;
}

export function classifyAddressType(address, outputScriptType) {
  if (outputScriptType) {
    if (outputScriptType.includes("taproot")) return "P2TR";
    if (outputScriptType.includes("witness_v0_keyhash")) return "P2WPKH";
    if (outputScriptType.includes("witness_v0_scripthash")) return "P2WSH";
    if (outputScriptType.includes("scripthash")) return "P2SH";
    if (outputScriptType.includes("pubkeyhash")) return "P2PKH";
    if (outputScriptType.includes("pubkey")) return "P2PK";
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("bc1p")) return "P2TR";
  if (normalized.startsWith("bc1q")) return address.length > 50 ? "P2WSH" : "P2WPKH";
  if (normalized.startsWith("3")) return "P2SH";
  if (normalized.startsWith("1")) return "P2PKH";

  return "Unknown";
}

export function classifyRisk(addressType, hasSpent, txCount, spendProfile = null) {
  if (txCount === 0) {
    return {
      tier: "Tier 5",
      label: "Unknown history",
      badgeClass: "unknown",
      headline: "No on-chain history found",
      explanation:
        "The selected API returned no transactions for this address, so the checker cannot establish an exposure profile yet.",
      actions: [
        "Verify the address on another explorer in case the API is temporarily incomplete.",
        "If this is a brand-new address, keep it receive-only until you need to move funds.",
        "Prefer single-use addresses to reduce future key exposure.",
      ],
    };
  }

  if (addressType === "P2PK") {
    return {
      tier: "Tier 1",
      label: "High risk",
      badgeClass: "high",
      headline: "Public key is directly embedded in the output",
      explanation:
        "P2PK outputs publish the key in the locking script itself. If funds remain there, they are broadly treated as the most exposed legacy case.",
      actions: [
        "Sweep remaining funds into a fresh modern address immediately.",
        "Avoid reusing any legacy output pattern that reveals keys directly.",
        "Use a wallet that defaults to native SegWit or a future quantum-hardened upgrade path.",
      ],
    };
  }

  if (hasSpent && ["P2PKH", "P2WPKH"].includes(addressType)) {
    return {
      tier: "Tier 2",
      label: "Exposed",
      badgeClass: "high",
      headline: "Spend history likely exposed key material",
      explanation:
        "This address has spent outputs. For common spend paths, that reveals the public key or redeeming script material needed to validate the spend, which is the main quantum concern this app is tracking.",
      actions: [
        "Move funds to a fresh address that has never spent.",
        "Stop reusing this address for new deposits.",
        "Track wallet support for future post-quantum migration paths and move again when available.",
      ],
    };
  }

  if (hasSpent && addressType === "P2WSH") {
    return {
      tier: "Tier 2",
      label: "Script path exposed",
      badgeClass: "high",
      headline: "Spent P2WSH revealed witness-script details",
      explanation:
        "This address has spent outputs from a witness-script construction. That spending path typically reveals witness-script structure and may reveal public keys depending on the script.",
      actions: [
        "Treat the spent script as public and avoid receiving to it again.",
        "Rotate funds into fresh outputs with a simpler, intentional policy.",
        "Document the descriptor so future migration does not depend on reverse-engineering scripts from chain data.",
      ],
    };
  }

  if (addressType === "P2TR") {
    return {
      tier: "Tier 3",
      label: "Taproot",
      badgeClass: "medium",
      headline: "Taproot output key is committed on-chain",
      explanation:
        "Taproot outputs commit an x-only public key in the output itself. Spend-path details differ from older scripts, but the address is not treated as a receive-only hash lock in the way P2WPKH is.",
      actions: [
        "Avoid unnecessary address reuse.",
        "If your threat model is conservative, rotate into fresh addresses rather than consolidating onto one long-lived Taproot output.",
        "Monitor wallet guidance as Bitcoin quantum-mitigation standards mature.",
      ],
    };
  }

  if (addressType === "P2SH" && hasSpent) {
    if (spendProfile?.multisig) {
      return {
        tier: "Tier 2",
        label: "Multisig exposed",
        badgeClass: "high",
        headline: "Spent P2SH revealed a multisig or custom script",
        explanation:
          "This address spent through a redeem or witness script that appears to expose multisig or other custom script logic on-chain. That is more specific than a generic P2SH unknown.",
        actions: [
          "Assume the redeeming script structure is now public.",
          "Move remaining funds to a fresh output policy and stop reusing this address.",
          "Capture the wallet descriptor or script policy outside the chain for future migrations.",
        ],
      };
    }

    if (spendProfile?.wrappedSegwit) {
      return {
        tier: "Tier 2",
        label: "Wrapped SegWit spent",
        badgeClass: "high",
        headline: "Spent P2SH revealed a wrapped SegWit redeem path",
        explanation:
          "This address appears to have spent through a redeem script wrapping SegWit. That redeem path is now public, so the address is no longer just a hidden-script case.",
        actions: [
          "Retire the address and use fresh native SegWit outputs instead of wrapped ones.",
          "Avoid consolidating additional funds into already-spent wrapped-script addresses.",
          "Prefer descriptors that make future migration easier to audit.",
        ],
      };
    }

    if (spendProfile?.scriptPathExposed) {
      return {
        tier: "Tier 2",
        label: "Script path exposed",
        badgeClass: "high",
        headline: "Spent P2SH revealed script details on-chain",
        explanation:
          "This address has already spent through a redeem path. Even if the exact script family is not fully classified here, the output is no longer a pure hidden-script case.",
        actions: [
          "Treat the script as publicly exposed and retire the address.",
          "Review the descriptor or wallet policy if funds are still associated with the same script family.",
          "Migrate to a fresh address rather than reusing this one for future receipts.",
        ],
      };
    }
  }

  if (addressType === "P2SH") {
    return {
      tier: "Tier 5",
      label: "Complex script",
      badgeClass: "unknown",
      headline: "P2SH needs deeper script inspection",
      explanation:
        "A P2SH address hides a redeem script until spend time. The exact quantum exposure depends on what sits behind that script, so this lightweight checker treats it as a manual-review case.",
      actions: [
        "Inspect the redeem script or wallet descriptor if you control it.",
        "If the address has already spent, assume some script details are now public.",
        "Prefer simpler, non-reused receive addresses where possible.",
      ],
    };
  }

  if (!hasSpent && ["P2PKH", "P2WPKH"].includes(addressType)) {
    return {
      tier: "Tier 4",
      label: "Safer",
      badgeClass: "low",
      headline: "No spend history detected",
      explanation:
        "This looks like a common address type with no detected spends. The checker did not find evidence that key material has been revealed through a spend yet.",
      actions: [
        "Keep this address receive-only if possible.",
        "Generate a fresh address for each new payment.",
        "Plan for future wallet upgrades instead of waiting for emergency migration.",
      ],
    };
  }

  return {
    tier: "Tier 5",
    label: "Unknown",
    badgeClass: "unknown",
    headline: "Exposure needs manual review",
    explanation:
      "The script type or history did not map cleanly to the checker’s lightweight rules. A full transaction-level review would be needed.",
    actions: [
      "Review the address in a block explorer that shows full scripts and witnesses.",
      "Avoid reusing the address while the script details are uncertain.",
      "If funds are material, migrate with a wallet whose descriptor you understand.",
    ],
  };
}

export function findFirstSpendingTx(address, txs) {
  let earliest = null;
  for (const tx of txs) {
    const isSpend = tx.vin?.some((vin) => vin.prevout?.scriptpubkey_address === address);
    if (!isSpend || !tx.status?.confirmed) continue;
    if (!earliest || tx.status.block_height < earliest.blockHeight) {
      earliest = {
        txid: tx.txid,
        blockHeight: tx.status.block_height,
        blockTime: tx.status.block_time,
      };
    }
  }
  return earliest;
}

export function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
