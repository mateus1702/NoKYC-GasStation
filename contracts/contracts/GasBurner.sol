// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title GasBurner
 * @notice Burns gas predictably for testing (e.g. profitability refill). Deploy only on Anvil.
 * @dev Use burnCompute for pure compute, burnStorage for SSTORE, burnMixed for both.
 */
contract GasBurner {
    uint256 public accumulator;

    /// @notice Burns gas via keccak256 compute loops. ~200-300 gas per iteration.
    function burnCompute(uint256 iterations) external {
        uint256 acc;
        for (uint256 i = 0; i < iterations; ) {
            acc = uint256(keccak256(abi.encode(acc, i)));
            unchecked {
                ++i;
            }
        }
        accumulator = acc;
    }

    /// @notice Burns gas via SSTORE writes. ~20k gas per cold write, ~2.9k per warm.
    function burnStorage(uint256 writes) external {
        for (uint256 i = 0; i < writes; ) {
            accumulator = i;
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Burns gas via compute + storage. Combines burnCompute and burnStorage.
    function burnMixed(uint256 writes, uint256 iterations) external {
        uint256 acc;
        for (uint256 i = 0; i < iterations; ) {
            acc = uint256(keccak256(abi.encode(acc, i)));
            unchecked {
                ++i;
            }
        }
        for (uint256 i = 0; i < writes; ) {
            accumulator = acc + i;
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Returns accumulator (view). Prevents optimizer from removing side effects.
    function sink() external view returns (uint256) {
        return accumulator;
    }
}
