import test from "node:test";
import assert from "node:assert/strict";

function parseAddressList(value) {
  return [...new Set(value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function resolveProviderConfig(selectedValue, customValue) {
  const providers = {
    "https://blockstream.info/api": {
      name: "Blockstream",
      url: "https://blockstream.info/api",
    },
  };

  if (selectedValue !== "custom") {
    return {
      ok: true,
      value: providers[selectedValue],
    };
  }

  const trimmed = customValue.trim().replace(/\/+$/, "");

  if (!trimmed) {
    return {
      ok: false,
      error: "Enter a custom Esplora-compatible API endpoint.",
    };
  }

  try {
    const url = new URL(trimmed);
    return {
      ok: true,
      value: {
        name: `Custom endpoint (${url.host})`,
        url: trimmed,
      },
    };
  } catch {
    return {
      ok: false,
      error: "Custom endpoint must be a valid URL.",
    };
  }
}

test("parseAddressList splits newline and comma separated input", () => {
  assert.deepEqual(
    parseAddressList("bc1qone\nbc1qtwo, 3three\nbc1qone"),
    ["bc1qone", "bc1qtwo", "3three"]
  );
});

test("resolveProviderConfig accepts custom endpoints and trims trailing slash", () => {
  const result = resolveProviderConfig("custom", "https://node.example.com/api/");
  assert.equal(result.ok, true);
  assert.equal(result.value.url, "https://node.example.com/api");
});

test("resolveProviderConfig rejects invalid custom endpoints", () => {
  const result = resolveProviderConfig("custom", "not-a-url");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Custom endpoint must be a valid URL.");
});
