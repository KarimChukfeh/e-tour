#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_PATH="$ROOT_DIR/v2/hardhat.config.js"

if [[ -z "${ARBISCAN_API_KEY:-}" ]]; then
  echo "ARBISCAN_API_KEY is not set."
  echo "Export it first, for example:"
  echo "  export ARBISCAN_API_KEY=your_arbiscan_api_key"
  exit 1
fi

run_verify() {
  local address="$1"
  shift || true

  echo ""
  echo "Verifying $address"

  local output
  if output=$(cd "$ROOT_DIR" && npx hardhat verify --config "$CONFIG_PATH" --network arbitrum "$address" "$@" 2>&1); then
    echo "$output"
    return 0
  fi

  echo "$output"

  if [[ "$output" == *"Already Verified"* ]] || [[ "$output" == *"already verified"* ]] || [[ "$output" == *"Contract source code already verified"* ]]; then
    echo "Continuing: $address is already verified."
    return 0
  fi

  return 1
}

echo "Using project root: $ROOT_DIR"
echo "Compiling v2 contracts..."
(cd "$ROOT_DIR" && npx hardhat compile --config "$CONFIG_PATH")

# Shared instance modules
run_verify 0x82533c127dB9fda79e9dE2D53DA576bf8AA17d58
run_verify 0x392BDF33438FfE60E31830E35e52f9F159AeB9f5
run_verify 0x10Ce922Ad8aeF6AC0eb0820b07021D3854363F51
run_verify 0xc6778C2E5D7ECC7C02cF4d867e351F0A2eb854df
run_verify 0x8b1aD0301EAAe8d47586c6c1b2dAdE85a39a225B

# TicTac
run_verify 0xB6C56D29688baD605592AF67f25eaE57c1CA3733
run_verify 0x717A2d2A71eCb8D1f53dC56Ef4Bf446Aa541D2F0 0xB6C56D29688baD605592AF67f25eaE57c1CA3733
run_verify 0x0d221c77A1af507B1Fd5eCEaeB8e0a98777BA3aF
run_verify 0xf5443410Ec5c540619855111692B603c374B07e2 \
  0x82533c127dB9fda79e9dE2D53DA576bf8AA17d58 \
  0x392BDF33438FfE60E31830E35e52f9F159AeB9f5 \
  0x10Ce922Ad8aeF6AC0eb0820b07021D3854363F51 \
  0xc6778C2E5D7ECC7C02cF4d867e351F0A2eb854df \
  0x717A2d2A71eCb8D1f53dC56Ef4Bf446Aa541D2F0

# ConnectFour
run_verify 0x46f7B004577850fE0a0A52a857532C6C11746519
run_verify 0x9C969A64703B2aF4026bfF9D71F86343768EE7d4 0x46f7B004577850fE0a0A52a857532C6C11746519
run_verify 0x5c69762E8D8bd244129a7C369CD470e3Be8D02E7
run_verify 0xe7Bf30FA457cA5Ff22F1b21E48D20395556427a3 \
  0x82533c127dB9fda79e9dE2D53DA576bf8AA17d58 \
  0x392BDF33438FfE60E31830E35e52f9F159AeB9f5 \
  0x10Ce922Ad8aeF6AC0eb0820b07021D3854363F51 \
  0xc6778C2E5D7ECC7C02cF4d867e351F0A2eb854df \
  0x9C969A64703B2aF4026bfF9D71F86343768EE7d4

# Chess
run_verify 0x9972297A029b5e7c0b16cA1a1a04Ec9Be4654Cbf
run_verify 0xe8e4752610A94b62bD94De0030C963d6836a75CA 0x9972297A029b5e7c0b16cA1a1a04Ec9Be4654Cbf
run_verify 0xDA40A06A880fB972751989031C3425918b9f93DC
run_verify 0x52bec690e6AD2ea4277cBe2F6293A094a049dcA2 \
  0x82533c127dB9fda79e9dE2D53DA576bf8AA17d58 \
  0x392BDF33438FfE60E31830E35e52f9F159AeB9f5 \
  0x10Ce922Ad8aeF6AC0eb0820b07021D3854363F51 \
  0xc6778C2E5D7ECC7C02cF4d867e351F0A2eb854df \
  0x8b1aD0301EAAe8d47586c6c1b2dAdE85a39a225B \
  0xe8e4752610A94b62bD94De0030C963d6836a75CA

echo ""
echo "Verification run complete."
