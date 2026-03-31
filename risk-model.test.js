import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssessment,
  classifyAddressType,
  classifyRisk,
  findFirstSpendingTx,
  inferOutputScriptType,
  inferSpendProfile,
} from "./risk-model.js";

test("classifyAddressType detects common prefixes", () => {
  assert.equal(
    classifyAddressType("bc1p5cyxnuxmeuwuvkwfem96lxyepd7fg5r8z7n0w8a6m2h7r6w9s0mq8j9f4m", null),
    "P2TR"
  );
  assert.equal(
    classifyAddressType("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", null),
    "P2WPKH"
  );
  assert.equal(classifyAddressType("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", null), "P2SH");
  assert.equal(classifyAddressType("1BoatSLRHtKNngkdXEeobR76b53LETtpyT", null), "P2PKH");
});

test("inferOutputScriptType reads the address output from tx history", () => {
  const scriptType = inferOutputScriptType("bc1qtarget", [
    {
      vout: [
        { scriptpubkey_address: "bc1qother", scriptpubkey_type: "v0_p2wpkh" },
        { scriptpubkey_address: "bc1qtarget", scriptpubkey_type: "v1_p2tr" },
      ],
    },
  ]);

  assert.equal(scriptType, "v1_p2tr");
});

test("classifyRisk marks spent segwit and legacy receive addresses differently", () => {
  assert.equal(classifyRisk("P2WPKH", true, 3).tier, "Tier 2");
  assert.equal(classifyRisk("P2PKH", false, 2).tier, "Tier 4");
  assert.equal(classifyRisk("P2TR", false, 1).tier, "Tier 3");
  assert.equal(classifyRisk("P2SH", true, 2).tier, "Tier 5");
});

test("inferSpendProfile detects wrapped segwit and multisig spends", () => {
  const wrapped = inferSpendProfile("3Wrapped", [
    {
      vin: [
        {
          prevout: {
            scriptpubkey_address: "3Wrapped",
          },
          inner_redeemscript_asm: "OP_0 OP_PUSHBYTES_20 1234",
          witness: ["3044", "02".repeat(33)],
        },
      ],
    },
  ]);

  assert.equal(wrapped.wrappedSegwit, true);
  assert.equal(wrapped.scriptPathExposed, true);

  const multisig = inferSpendProfile("3Multi", [
    {
      vin: [
        {
          prevout: {
            scriptpubkey_address: "3Multi",
          },
          inner_witnessscript_asm: "OP_2 OP_PUSHBYTES_33 A OP_PUSHBYTES_33 B OP_2 CHECKMULTISIG",
        },
      ],
    },
  ]);

  assert.equal(multisig.multisig, true);
  assert.equal(multisig.witnessScriptExposed, true);
});

test("buildAssessment produces a consistent exposed result", () => {
  const model = buildAssessment(
    "bc1qtarget",
    {
      chain_stats: {
        tx_count: 4,
        funded_txo_sum: 125000000,
        spent_txo_sum: 25000000,
        spent_txo_count: 1,
      },
      mempool_stats: {
        tx_count: 0,
        funded_txo_sum: 0,
        spent_txo_sum: 0,
        spent_txo_count: 0,
      },
    },
    [
      {
        vout: [
          {
            scriptpubkey_address: "bc1qtarget",
            scriptpubkey_type: "v0_p2wpkh",
          },
        ],
      },
    ],
    { name: "Test API", url: "https://example.test/api" }
  );

  assert.equal(model.addressType, "P2WPKH");
  assert.equal(model.balance, 100000000);
  assert.equal(model.risk.tier, "Tier 2");
  assert.equal(model.isReused, true);
  assert.equal(model.txsAnalyzed, 1);
  assert.equal(model.firstExposedAt, null);
});

test("findFirstSpendingTx returns earliest confirmed spend or null", () => {
  const address = "bc1qtarget";
  const txs = [
    {
      txid: "aaa",
      status: { confirmed: true, block_height: 840200, block_time: 1713600000 },
      vin: [{ prevout: { scriptpubkey_address: address } }],
    },
    {
      txid: "bbb",
      status: { confirmed: true, block_height: 840100, block_time: 1713500000 },
      vin: [{ prevout: { scriptpubkey_address: address } }],
    },
    {
      txid: "ccc",
      status: { confirmed: false, block_height: null, block_time: null },
      vin: [{ prevout: { scriptpubkey_address: address } }],
    },
  ];

  const result = findFirstSpendingTx(address, txs);
  assert.equal(result.txid, "bbb");
  assert.equal(result.blockHeight, 840100);
  assert.equal(result.blockTime, 1713500000);

  assert.equal(findFirstSpendingTx(address, []), null);
  assert.equal(findFirstSpendingTx("other", txs), null);
});

test("buildAssessment upgrades spent P2SH into a specific exposed case", () => {
  const model = buildAssessment(
    "3Wrapped",
    {
      chain_stats: {
        tx_count: 3,
        funded_txo_sum: 50000000,
        spent_txo_sum: 30000000,
        spent_txo_count: 1,
      },
      mempool_stats: {
        tx_count: 0,
        funded_txo_sum: 0,
        spent_txo_sum: 0,
        spent_txo_count: 0,
      },
    },
    [
      {
        vout: [
          {
            scriptpubkey_address: "3Wrapped",
            scriptpubkey_type: "p2sh",
          },
        ],
      },
      {
        vin: [
          {
            prevout: {
              scriptpubkey_address: "3Wrapped",
            },
            inner_redeemscript_asm: "OP_0 OP_PUSHBYTES_20 1234",
            witness: ["3044", "02".repeat(33)],
          },
        ],
      },
    ],
    { name: "Test API", url: "https://example.test/api" }
  );

  assert.equal(model.addressType, "P2SH");
  assert.equal(model.spendProfile.wrappedSegwit, true);
  assert.equal(model.risk.tier, "Tier 2");
});
